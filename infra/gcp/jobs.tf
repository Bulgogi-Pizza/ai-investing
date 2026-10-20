# Scheduled Cloud Run Jobs (stage 4 foundation; stages 6b and 7c add jobs the same way).
#
# Terraform owns the identities, secret access and the Cloud Scheduler triggers. The Cloud Run Job
# `investing-daily-snapshot` itself is deployed by .github/workflows/deploy.yml with the same verified
# image digest as the service (like the service, it is not a Terraform resource, so no image drift).
# The workflow also grants the scheduler account roles/run.invoker on that single job.

variable "snapshot_schedules_enabled" {
  type        = bool
  default     = false
  description = "Keep the Cloud Scheduler triggers paused until the first job deployment exists."
}

locals {
  daily_snapshot_job = "investing-daily-snapshot"
  # The job reads the Toss credentials, the linked account and the owner id (target holdings).
  jobs_toss_secrets = toset(["investing-toss-client-id", "investing-toss-client-secret", "investing-toss-account-seq", "investing-toss-owner-user-id"])
}

resource "google_service_account" "jobs" {
  account_id   = "investing-jobs"
  display_name = "Scheduled data jobs"
  depends_on   = [google_project_service.api]
}

# Firestore has no per-collection IAM; datastore.user is the same role the runtime holds.
resource "google_project_iam_member" "jobs_store" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.jobs.email}"
}

# Per-secret access only. No project-level secretAccessor, and nothing beyond the Toss secrets.
resource "google_secret_manager_secret_iam_member" "jobs_toss" {
  for_each  = local.jobs_toss_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.toss[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}

# The deploy workflow creates the job with this identity.
resource "google_service_account_iam_member" "act_as_jobs" {
  service_account_id = google_service_account.jobs.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API. It holds no project roles: the
# deploy workflow binds roles/run.invoker (run.jobs.run) on the one job it may start.
resource "google_service_account" "scheduler" {
  account_id   = "investing-scheduler"
  display_name = "Cloud Scheduler job invoker"
  depends_on   = [google_project_service.api]
}

# Weekdays 16:30 and 18:30 KST, one and three hours after the KRX 15:30 close. The job re-checks the
# market calendar: holidays are skipped, a completed day is not repeated, and the second slot only
# retries a day that is still incomplete.
resource "google_cloud_scheduler_job" "daily_snapshot_kr" {
  name             = "investing-daily-snapshot-kr"
  description      = "Daily snapshot after the Korean close"
  region           = var.region
  schedule         = "30 16,18 * * 1-5"
  time_zone        = "Asia/Seoul"
  paused           = !var.snapshot_schedules_enabled
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.daily_snapshot_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}

# Tuesday-Saturday 06:30 and 07:30 KST. The US regular session closes at 05:00 KST in summer time and
# 06:00 KST otherwise (earlier on half days); the job reads the actual close from the calendar and the
# second slot only re-runs a day that is not yet complete.
resource "google_cloud_scheduler_job" "daily_snapshot_us" {
  name             = "investing-daily-snapshot-us"
  description      = "Daily snapshot after the US close (two slots cover daylight saving time)"
  region           = var.region
  schedule         = "30 6,7 * * 2-6"
  time_zone        = "Asia/Seoul"
  paused           = !var.snapshot_schedules_enabled
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.daily_snapshot_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}

output "jobs_service_account" { value = google_service_account.jobs.email }
output "scheduler_service_account" { value = google_service_account.scheduler.email }
