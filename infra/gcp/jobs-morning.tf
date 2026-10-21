# Morning calendar job (stage 6b). Same pattern as jobs.tf: Terraform owns secret access and the
# Cloud Scheduler trigger; the Cloud Run Job `investing-morning-calendar` itself is deployed by
# .github/workflows/deploy.yml with the verified image digest (docs/operations/jobs.md).
#
# The job runs as the existing `investing-jobs` service account (jobs.tf) and the existing
# `investing-scheduler` account invokes it; the deploy workflow binds roles/run.invoker on this one job.

variable "morning_schedule_enabled" {
  type        = bool
  default     = false
  description = "Keep the morning calendar trigger paused until the job exists and has run once by hand."
}

variable "morning_ai_enabled" {
  type        = bool
  default     = false
  description = "Grant the jobs account Vertex AI access (roles/aiplatform.user) for the AI steps of the morning job and the calendar-enrich job (Claude Sonnet 5.5 on Vertex AI). The default stays false so a fresh project grants nothing; the user approved the AI cost on 2026-10-21, so the operator sets morning_ai_enabled = true in terraform.tfvars (docs/operations/jobs.md). Claude on Vertex also needs the model enabled and quota in the project (currently 0 for anthropic-claude-sonnet in region global until an increase is approved)."
}

locals {
  morning_calendar_job = "investing-morning-calendar"
  # FRED/ECOS read released values and release dates; Telegram delivers the brief. All four are
  # created in providers.tf (values are stored with scripts/provider-secrets.py).
  jobs_morning_secrets = toset(["investing-fred-api-key", "investing-ecos-api-key", "investing-telegram-bot-token", "investing-telegram-chat-id"])
}

# Per-secret access only. No project-level secretAccessor.
resource "google_secret_manager_secret_iam_member" "jobs_morning" {
  for_each  = local.jobs_morning_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.provider[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}

# Vertex AI call permission, only when the AI steps are meant to be used. deploy.yml now sets
# MORNING_AI_ENABLED=true on the morning job and CALENDAR_AI_ENABLED=true on the manual
# investing-calendar-enrich job (same service account); without this grant those steps record
# AI_AUTH_UNAVAILABLE and the rest of the run is unaffected. The calendar-enrich job itself has no
# scheduler and no Terraform resource: deploy.yml creates it and the operator runs it by hand.
resource "google_project_iam_member" "jobs_ai" {
  count   = var.morning_ai_enabled ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.jobs.email}"
}

# Every day 07:00 KST. The job is idempotent per KST date: a completed day is skipped and a failed
# day is retried by the next manual or scheduled run.
resource "google_cloud_scheduler_job" "morning_calendar" {
  name             = "investing-morning-calendar"
  description      = "Morning calendar refresh: released values, upcoming events, optional AI summaries, brief"
  region           = var.region
  schedule         = "0 7 * * *"
  time_zone        = "Asia/Seoul"
  paused           = !var.morning_schedule_enabled
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.morning_calendar_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}
