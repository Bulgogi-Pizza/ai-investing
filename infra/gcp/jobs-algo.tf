# Paper (virtual) algorithm run, stage 7c. Same shape as the daily snapshot jobs in jobs.tf.
#
# One Cloud Run Job `investing-algo-paper` (deployed by .github/workflows/deploy.yml with the same
# verified image digest, like investing-daily-snapshot). Two Scheduler triggers pick the market per
# execution through an ALGO_MARKET override. The job itself decides from the Toss market calendar
# whether the regular session just opened, so US daylight saving time needs no schedule change: the
# 22:35 slot is the real one in summer, the 23:35 slot in winter, the other finds nothing to do.
# Nothing in this job places an order; it reuses the investing-jobs identity.

variable "algo_schedules_enabled" {
  type        = bool
  default     = false
  description = "Keep the paper algorithm Cloud Scheduler triggers paused until the job deployment exists and a manual run was checked."
}

locals {
  algo_paper_job = "investing-algo-paper"
  # Telegram notifications (fills, automatic stop, job failure). Delivery failures never block a run.
  jobs_telegram_secrets = toset(["investing-telegram-bot-token", "investing-telegram-chat-id"])
}

# Per-secret access only (no project-level secretAccessor).
resource "google_secret_manager_secret_iam_member" "jobs_telegram" {
  for_each  = local.jobs_telegram_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.provider[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}

# Weekdays 09:05 KST, five minutes after the KRX open. Holidays are skipped by the job.
resource "google_cloud_scheduler_job" "algo_paper_kr" {
  name             = "investing-algo-paper-kr"
  description      = "Paper algorithm run just after the Korean open"
  region           = var.region
  schedule         = "5 9 * * 1-5"
  time_zone        = "Asia/Seoul"
  paused           = !var.algo_schedules_enabled
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.algo_paper_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ overrides = { containerOverrides = [{ env = [{ name = "ALGO_MARKET", value = "KR" }] }] } }))
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}

# Weekdays 22:35 and 23:35 KST. The US regular session opens 22:30 KST in summer time and 23:30 KST
# otherwise; the job reads the actual open from the calendar and runs only within minutes after it,
# so exactly one of the two slots acts and the run record dedupes per market and date.
resource "google_cloud_scheduler_job" "algo_paper_us" {
  name             = "investing-algo-paper-us"
  description      = "Paper algorithm run just after the US open (two slots cover daylight saving time)"
  region           = var.region
  schedule         = "35 22,23 * * 1-5"
  time_zone        = "Asia/Seoul"
  paused           = !var.algo_schedules_enabled
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.algo_paper_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ overrides = { containerOverrides = [{ env = [{ name = "ALGO_MARKET", value = "US" }] }] } }))
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}
