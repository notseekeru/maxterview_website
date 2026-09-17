Alex D. Mender
EDUCATION
Mary The Queens College Pampanga
Bachelor of Science in Computer Engineering Expected 2029
PROJECTS
Managed Cloud Homelab Automation Multi-Cloud Orchestration & GitOps
• Provisioned a cost-bounded multi-cloud infrastructure (AWS, DigitalOcean, K3s, Cloudflare) with Terraform, enforcing
declarative GitOps reconciliation using ArgoCD App-of-Apps pattern.
• Eliminated plaintext secrets across Terraform, Docker, and Ansible by centralizing credentials in Infisical with path-based
secret referencing, establishing a single source of truth that dynamically injects 24+ secured static secrets.
• Implemented automated, encrypted backup pipelines to Cloudflare R2 using S3-compatible APIs and Terraform backend
state locking to ensure no overwrite loss.
• Debugged provider endpoint collisions between Cloudflare R2 and AWS S3 using isolation and custom provider overrides.
• Automated deployment loops with commit image tagging, Trivy, and deploy keys, eliminating deployment friction.
Homelab Infrastructure Development & Automation & Security Configuration Management & Security
• Hardened web applications with CSP, TLS 1.3, and strict security headers, multi-arch (ARM64/AMD64) QEMU Builds,
Read-only FS and tmpfs, achieving an SSL Labs ’A+’ grade on personal websites hosted behind an Nginx reverse proxy.
• Secured least-privilege access controls by implementing Tailscale ACLs, restricting ephemeral and public machines from
accessing resources inside the private network.
• Automated server deployment with Ansible roles and Molecule Docker for testing, ensuring idempotency.
• Integrated reproducible, developer environments across repositories using Nix Flakes, direnv, and gitleaks to bind tool
dependencies (Terraform, kubectl, Ansible, Python) to exact lockfile versions.
• Engineered a custom agentic skill to bridge headless AI agents with Playwright, enabling the agent to dynamically navigate
Clerk auth and Stripe flows to catch client-side regressions.
LGTM + OpenTelemetry - Observability Experiment Telemetry & Monitoring Pipelines
• Optimized system performance on a resource-constrained machine, maintaining application latency under 30ms by con-
structing Grafana dashboards and tuning OpenTelemetry batch processing.
• Achieved ∼2.5s alert detection in a homelab environment by simulating failures with blackout injection in Python, con-
figuring high-frequency scraping, creating alert rules in Prometheus, and routing Slack notifications via Alertmanager.
• Deployed Alloy and OpenTelemetry to create a vendor-neutral telemetry pipeline, enabling unified system and application
monitoring across the homelab infrastructure.
TCP/HTTP L7 Networking Stack & L4 Load Balancer (Go) Systems & Network Programming
• Built an HTTP/1.1 server from scratch using Go without frameworks, connection loops, byte streaming, and bidirectional
io Round-robin client-server transfers to eliminate networking knowledge abstractions.
• Resolved a data loss bug by chaining io.LimitReader onto an active bufio.Reader buffer instead of the raw net.Conn socket,
preventing accidental discarding of pre-fetched network bytes.
• Featured an HTTP/1.1 request parser supporting GET/POST routing, dynamic Content-Length, static file serving, persis-
tent keep-alive connections, and testing suite eg. Path Traversal.
AWS 3-Tier Infrastructure on Terraform (SAA-C03) Cloud Architecture & IaC
• Provisioned a 3-tier architecture in AWS across managed resources, engineered to stay within Free Tier cost boundaries.
• Offloaded static assets to a private S3 bucket served via CloudFront with Origin Access Control and an explicit bucket
policy, cutting origin load while keeping assets inaccessible to the public.
• Implemented cost observability with CloudWatch alarms, an AWS Zero-Spend budget, and a credit-cap budget publishing
SNS alerts on 95% actual / 90% forecast spend as a guard against billable overrun.
SKILLS
• Infrastructure: AWS, Cloudflare, Terraform, Kubernetes (Single/Managed), Ansible, Docker, Linux, Nginx, Nix
• Observability: Grafana, Prometheus, Alloy, Loki, Tempo, Alertmanager, OpenTelemetry
• CI/CD: ArgoCD(Gitops), GitHub Actions, GitHub Flow, Trivy, Dependabot, Renovate
• Languages: Python, Go, Bash, HCL, TypeScript, SQL
