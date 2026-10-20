terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}
variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-northeast3"
}
variable "github_repository" {
  type        = string
  description = "Exact owner/repo, e.g. OWNER/ai-investing"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use owner/repository."
  }
}
variable "github_repository_id" {
  type        = string
  description = "Immutable numeric GitHub repository ID from gh api repos/OWNER/REPO --jq .id"
  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "A numeric repository ID is required."
  }
}
variable "billing_account" {
  type    = string
  default = ""
}
variable "monthly_budget_amount" {
  type    = number
  default = 10
}

variable "budget_currency" {
  type    = string
  default = "USD"
  validation {
    condition     = can(regex("^[A-Z]{3}$", var.budget_currency))
    error_message = "Use the billing account currency code."
  }
}

locals {
  services = toset(["aiplatform.googleapis.com", "cloudbilling.googleapis.com", "cloudresourcemanager.googleapis.com", "run.googleapis.com", "artifactregistry.googleapis.com", "firestore.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "secretmanager.googleapis.com", "billingbudgets.googleapis.com"])
}
resource "google_project_service" "api" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}
resource "google_artifact_registry_repository" "app" {
  location               = var.region
  repository_id          = "ai-investing"
  format                 = "DOCKER"
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-latest"
    action = "KEEP"
    most_recent_versions { keep_count = 5 }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition { older_than = "2592000s" }
  }
  depends_on = [google_project_service.api]
}
resource "google_firestore_database" "app" {
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  depends_on                        = [google_project_service.api]
}
resource "google_service_account" "runtime" {
  account_id   = "investing-runtime"
  display_name = "Investing API runtime"
  depends_on   = [google_project_service.api]
}
resource "google_project_iam_member" "runtime_store" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_service_account" "deploy" {
  account_id   = "investing-deploy"
  display_name = "GitHub main branch deployment"
  depends_on   = [google_project_service.api]
}
resource "google_project_iam_member" "deployer" {
  for_each = toset(["roles/run.admin"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deploy.email}"
}
resource "google_service_account_iam_member" "act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "investing-github"
  display_name              = "Investing GitHub OIDC"
  depends_on                = [google_project_service.api]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-main"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.repository"    = "assertion.repository"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.repository_id == '${var.github_repository_id}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${var.github_repository}/.github/workflows/deploy.yml@refs/heads/main' && assertion.environment == 'production' && assertion.event_name == 'workflow_run'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
resource "google_billing_budget" "app" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "ai-investing-monthly"
  budget_filter {
    projects = ["projects/${data.google_project.current.number}"]
  }
  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.monthly_budget_amount)
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
  depends_on = [google_project_service.api]
}
data "google_project" "current" {}
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "deploy_service_account" { value = google_service_account.deploy.email }
output "runtime_service_account" { value = google_service_account.runtime.email }
output "container_repository" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}" }
resource "google_firestore_field" "sessions_ttl" {
  project    = var.project_id
  database   = google_firestore_database.app.name
  collection = "sessions"
  field      = "ttlAt"
  ttl_config {}
  index_config {}
}
resource "google_firestore_field" "login_attempts_ttl" {
  project    = var.project_id
  database   = google_firestore_database.app.name
  collection = "loginAttempts"
  field      = "ttlAt"
  ttl_config {}
  index_config {}
}

resource "google_artifact_registry_repository_iam_member" "deployer_registry" {
  project    = var.project_id
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "runtime_ai" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_firestore_field" "ai_usage_ttl" {
  project    = var.project_id
  database   = google_firestore_database.app.name
  collection = "aiUsage"
  field      = "ttlAt"
  ttl_config {}
  index_config {}
}
