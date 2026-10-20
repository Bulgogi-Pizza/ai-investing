resource "google_project_service" "rules" {
  service            = "firebaserules.googleapis.com"
  disable_on_destroy = false
}
resource "google_firebaserules_ruleset" "server_only" {
  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/firestore.rules")
    }
  }
  depends_on = [google_project_service.rules, google_firestore_database.app]
}
resource "google_firebaserules_release" "server_only" {
  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.server_only.name
}
