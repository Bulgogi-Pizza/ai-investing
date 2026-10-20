# External provider keys and Telegram settings. Terraform manages metadata and access only; values are
# stored with scripts/provider-secrets.py (docs/operations/provider-setup.md).
locals {
  provider_secrets = toset([
    "investing-dart-api-key",
    "investing-fred-api-key",
    "investing-ecos-api-key",
    "investing-telegram-bot-token",
    "investing-telegram-chat-id",
    "investing-sec-user-agent",
  ])
}
resource "google_secret_manager_secret" "provider" {
  for_each  = local.provider_secrets
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.api]
}
# Runtime service account only. Job service accounts get their own per-secret grants in stage 4.
resource "google_secret_manager_secret_iam_member" "provider_runtime" {
  for_each  = local.provider_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.provider[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
