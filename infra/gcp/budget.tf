# App-level monthly budget stop (docs/operations/budget.md).
#
# Cloud Billing publishes budget notifications (all updates, schema 1.0) to a Pub/Sub topic. A push
# subscription delivers them to the app's /api/internal/budget-alert with a Google-signed OIDC token
# of the dedicated service account below. The app verifies issuer, audience and that exact e-mail, then
# pauses scheduled jobs and AI, and sets the emergency stop at 100% of the budget.
#
# Nothing here disables billing, and the default e-mail recipients of the budget stay enabled.
# Notifications arrive hours late, so this is best effort, not a hard spending cap.

variable "service_url" {
  type        = string
  default     = ""
  description = "HTTPS origin of the app, exactly the APP_ORIGIN value (no path, no trailing slash). It is the push endpoint host and the OIDC audience the app expects. Empty keeps the push subscription and the budget's Pub/Sub rule out. Set it in terraform.tfvars, not in the repository."
  validation {
    condition     = var.service_url == "" || can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?$", var.service_url))
    error_message = "Use an https origin without a path or trailing slash."
  }
}

locals {
  # Needs the budget itself (billing account) and the URL the push is delivered to.
  budget_push_enabled = var.billing_account != "" && var.service_url != ""
}

resource "google_pubsub_topic" "budget_alerts" {
  name       = "investing-budget-alerts"
  depends_on = [google_project_service.api]
}

# Identity of the push subscription. It holds no project roles: it exists only to be named in the
# OIDC token, and the app accepts nothing else.
resource "google_service_account" "budget_push" {
  account_id   = "investing-budget-push"
  display_name = "Budget alert Pub/Sub push"
  depends_on   = [google_project_service.api]
}

# Creates the Pub/Sub service agent (service-<project number>@gcp-sa-pubsub...) if it does not exist yet,
# so the binding below cannot fail on a missing identity. The provider documents the resource as beta.
resource "google_project_service_identity" "pubsub" {
  provider   = google-beta
  service    = "pubsub.googleapis.com"
  depends_on = [google_project_service.api]
}

# The Pub/Sub service agent mints the OIDC token for this one service account (and no other).
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.budget_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = google_project_service_identity.pubsub.member
}

resource "google_pubsub_subscription" "budget_push" {
  count                = local.budget_push_enabled ? 1 : 0
  name                 = "investing-budget-push"
  topic                = google_pubsub_topic.budget_alerts.id
  ack_deadline_seconds = 20
  expiration_policy {
    ttl = ""
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  push_config {
    push_endpoint = "${var.service_url}/api/internal/budget-alert"
    oidc_token {
      service_account_email = google_service_account.budget_push.email
      audience              = var.service_url
    }
  }
  depends_on = [google_project_service.api, google_service_account_iam_member.pubsub_token_creator]
}
