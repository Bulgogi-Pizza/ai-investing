# Toss requires an allowlisted outbound IP. Direct VPC egress avoids a paid connector.
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}
resource "google_compute_network" "app" {
  name                    = "investing-network"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.compute]
}
resource "google_compute_subnetwork" "app" {
  name                     = "investing-subnet"
  ip_cidr_range            = "10.41.0.0/26"
  region                   = var.region
  network                  = google_compute_network.app.id
  private_ip_google_access = true
}
resource "google_compute_address" "egress" {
  name       = "investing-egress"
  region     = var.region
  depends_on = [google_project_service.compute]
}
resource "google_compute_router" "app" {
  name    = "investing-router"
  network = google_compute_network.app.id
  region  = var.region
}
resource "google_compute_router_nat" "app" {
  name                               = "investing-nat"
  router                             = google_compute_router.app.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.egress.self_link]
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.app.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}
resource "google_project_iam_member" "deployer_network" {
  project = var.project_id
  role    = "roles/compute.networkUser"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}
output "toss_allowlist_ip" { value = google_compute_address.egress.address }
