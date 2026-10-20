# Provider secrets are separate from public code/state. Terraform manages metadata only.
locals {
  toss_secrets = toset(["investing-toss-client-id", "investing-toss-client-secret", "investing-toss-account-seq", "investing-toss-owner-user-id"])
}
resource "google_secret_manager_secret" "toss" {
  for_each  = local.toss_secrets
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}
resource "google_secret_manager_secret_iam_member" "toss_runtime" {
  for_each  = local.toss_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.toss[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_service_account" "toss_setup" {
  account_id   = "investing-setup"
  display_name = "One-off read-only Toss account discovery"
  depends_on   = [google_project_service.api]
}
resource "google_project_iam_member" "toss_setup_store" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.toss_setup.email}"
}
resource "google_secret_manager_secret_iam_member" "toss_setup_read" {
  for_each  = toset(["investing-toss-client-id", "investing-toss-client-secret"])
  project   = var.project_id
  secret_id = google_secret_manager_secret.toss[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.toss_setup.email}"
}
resource "google_secret_manager_secret_iam_member" "toss_setup_write" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.toss["investing-toss-account-seq"].secret_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.toss_setup.email}"
}
