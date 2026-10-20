# Live (real-money) algorithm run, stage 7f. Same shape as the paper run in jobs-algo.tf, with three
# differences that keep it from ever starting by accident:
#
#  1. The two Cloud Scheduler triggers are created PAUSED and stay paused until the operator sets
#     live_schedules_enabled = true (docs/operations/jobs.md lists the order of steps: access check,
#     the user's WTS Open API check, the user enabling live on ONE algorithm, only then this flag).
#  2. The Cloud Run Job `investing-algo-live` itself (deployed by .github/workflows/deploy.yml) runs
#     only when its kill-switch environment variable is exactly "true" (the workflow sets it on this job
#     and on nothing else; the variable name is in src/jobs/algo-live.ts).
#  3. The read-only access check job `investing-order-access-check` has NO schedule at all: it is run by
#     hand (gcloud run jobs execute), so it needs nothing here.
#
# Both jobs reuse the investing-jobs identity, which already holds the Toss secrets (jobs.tf) and the
# Telegram secrets (jobs-morning.tf). A second binding here would let one removal drop the other, so
# there is none. The job decides from the Toss market calendar whether the regular session just
# opened, so US daylight saving time needs no schedule change (the 22:35 slot is the real one in
# summer, the 23:35 slot in winter, the other finds nothing to do).

variable "live_schedules_enabled" {
  type        = bool
  default     = false
  description = "Keep the live algorithm Cloud Scheduler triggers paused. Set true only after the order access check passed, the user checked the WTS Open API settings and enabled live on one algorithm (docs/operations/jobs.md)."
}

locals {
  algo_live_job = "investing-algo-live"
}

# Weekdays 09:05 KST, five minutes after the KRX open. Holidays are skipped by the job.
resource "google_cloud_scheduler_job" "algo_live_kr" {
  name             = "investing-algo-live-kr"
  description      = "Live algorithm run just after the Korean open (REAL ORDERS; paused until live_schedules_enabled)"
  region           = var.region
  schedule         = "5 9 * * 1-5"
  time_zone        = "Asia/Seoul"
  paused           = !var.live_schedules_enabled
  attempt_deadline = "60s"
  # A retry only repeats a trigger the Run API did not accept; an accepted run is deduplicated by the
  # job's run record and every order by its deterministic clientOrderId.
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.algo_live_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ overrides = { containerOverrides = [{ env = [{ name = "ALGO_MARKET", value = "KR" }] }] } }))
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}

# Weekdays 22:35 and 23:35 KST. Exactly one of the two slots acts; the run record dedupes per market
# and date.
resource "google_cloud_scheduler_job" "algo_live_us" {
  name             = "investing-algo-live-us"
  description      = "Live algorithm run just after the US open (REAL ORDERS; paused until live_schedules_enabled; two slots cover daylight saving time)"
  region           = var.region
  schedule         = "35 22,23 * * 1-5"
  time_zone        = "Asia/Seoul"
  paused           = !var.live_schedules_enabled
  attempt_deadline = "60s"
  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.algo_live_job}:run"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ overrides = { containerOverrides = [{ env = [{ name = "ALGO_MARKET", value = "US" }] }] } }))
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
  depends_on = [google_project_service.api]
}
