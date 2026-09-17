# Infrastructure Diagram

How maxterview is wired: what serves traffic, how a commit reaches both environments, and where each
environment's config actually comes from. Shapes and counts verified 2026-09-17 (staging went live).
Update this file when the shape changes, not when a value changes.

## 1. Runtime topology

```mermaid
flowchart TD
    Browser["Browser: SPA + Clerk session cookie"]

    subgraph Edge["Cloudflare edge"]
        CF["DNS + Universal SSL<br/>maxterview.seekeru.tech<br/>maxterview-staging.seekeru.tech<br/>(first-level on purpose: Universal SSL covers only the zone apex and its wildcard)"]
        Tunnel["cloudflared tunnel (remote-managed ingress)<br/>staging hostname rule sits before the catch-all"]
    end

    subgraph Cluster["k3s on piserver (RPi5, reachable over Tailscale)"]
        Nginx["ingress-nginx (ClusterIP)<br/>shared by portfolio, diagram and maxterview"]

        subgraph ProdNS["namespace maxterview"]
            PIng["Ingress maxterview-ingress"]
            PBackend["Deployment maxterview-backend :8000<br/>replicas 1, envFrom maxterview-secrets"]
            PFrontend["Deployment maxterview-frontend :8080<br/>prod SPA, Clerk pk_live_ baked at build"]
            PJob["Job maxterview-migrate<br/>PreSync hook, yoyo apply --batch"]
        end

        subgraph StageNS["namespace maxterview-staging"]
            SIng["Ingress maxterview-ingress"]
            SBackend["Deployment maxterview-backend :8000<br/>replicas 1, envFrom maxterview-staging-secrets"]
            SFrontend["Deployment maxterview-frontend :8080<br/>staging SPA tag staging-sha, Clerk pk_test_ baked at build"]
            SJob["Job maxterview-migrate<br/>PreSync hook, same command"]
        end

        Argo["ArgoCD (helm, installed by terraform)<br/>root app gitops to apps-of-apps, 5 Applications<br/>maxterview to overlays/prod, maxterview-staging to overlays/staging"]
    end

    subgraph External["External services"]
        NeonProd["Neon prod project<br/>direct host, not -pooler"]
        NeonStage["Neon staging project<br/>direct host, not -pooler"]
        ClerkProd["Clerk Production instance<br/>clerk.seekeru.tech"]
        ClerkDev["Clerk Development instance<br/>known-polecat-16.clerk.accounts.dev"]
        PayLive["PayMongo live key + prod webhook endpoint"]
        PayTest["PayMongo test key + staging webhook endpoint"]
        LLM["Self-hosted qwen<br/>desktop, over Tailscale"]
        GHCR["GHCR, private images"]
        R2["Cloudflare R2<br/>terraform state only, no runtime traffic"]
    end

    Browser --> CF --> Tunnel --> Nginx
    Nginx --> PIng
    Nginx --> SIng
    PIng --> PBackend
    PIng --> PFrontend
    SIng --> SBackend
    SIng --> SFrontend
    PBackend --> NeonProd
    PBackend --> ClerkProd
    PBackend --> PayLive
    PBackend --> LLM
    SBackend --> NeonStage
    SBackend --> ClerkDev
    SBackend --> PayTest
    SBackend --> LLM
    SJob --> NeonProd
    PJob --> NeonProd
    Argo -.reconciles.-> ProdNS
    Argo -.reconciles.-> StageNS
    GHCR -.image pull via ghcr-login.-> PBackend
    GHCR -.image pull via ghcr-login.-> SBackend
```

Share these and you give the two environments a common failure mode: the cluster and node, ingress-nginx,
the tunnel, the LLM endpoint and the Neon org quota. The namespaces, secrets, database projects, Clerk
instance and payment mode are separate.

## 2. Deploy pipeline

```mermaid
flowchart LR
    Push["git push to main<br/>only frontend/**, backend/**, .github/workflows/**"]
    CI["CI on green paths<br/>backend: ruff + pytest against a throwaway postgres service<br/>frontend: biome + tsc + build<br/>Trivy scan of both images"]
    CD["CD runs on CI success, head_branch main<br/>build + push 3 images"]
    Images["GHCR<br/>maxterview_backend:sha + :latest<br/>maxterview_frontend:sha + :latest (pk_live_ SPA)<br/>maxterview_frontend:staging-sha (pk_test_ SPA, no latest)"]
    Bump["update-gitops-repo job<br/>kustomize edit set image on BOTH overlays<br/>push to gitops with MAXTERVIEW_SSH"]
    Sync["ArgoCD auto-sync<br/>prune + selfHeal"]
    Hook["PreSync Job maxterview-migrate per env<br/>yoyo apply --batch, ledger _yoyo_migration"]
    Roll["Rollout: backend + frontend in that namespace"]
    Docs["docs-only commits: CI is path-filtered, so nothing builds and nothing deploys"]

    Push --> CI --> CD --> Images --> Bump --> Sync --> Hook --> Roll
    Push -.-> Docs
```

One push to main moves prod and staging together, on the same SHA; there is no promotion step between them.
Staging is the rehearsal for the path, not a gate in front of it.

## 3. Config plane

```mermaid
flowchart TD
    subgraph Infisical["Infisical project, path /consumers/terraform"]
        ProdEnv["env prod: 24 keys, the source of truth"]
        StageEnv["env staging: 5 local overrides + 19 references<br/>KEY = prod.consumers.terraform.KEY"]
        Toggle["the dashboard inheritance toggle does not reach the API/CLI,<br/>references are what actually inherit"]
    end

    subgraph Terraform["terraform, one state key per module in R2"]
        ModProd["infra/k3s with ENV=prod"]
        ModStage["infra/k3s-staging with ENV=staging"]
    end

    subgraph K8s["k8s Secrets, 11 UPPERCASE keys each"]
        SecProd["maxterview-secrets (ns maxterview)<br/>prod Neon DSN, Clerk prod, live payment keys"]
        SecStage["maxterview-staging-secrets (ns maxterview-staging)<br/>staging Neon DSN, Clerk dev, test payment keys"]
        Ghcr["ghcr-login in default, maxterview and maxterview-staging"]
    end

    subgraph Local["dev plane, laptop only"]
        DevEnv["backend/.env + frontend/.env, git-ignored<br/>docker compose project maxterview-dev"]
    end

    Pods["pods read the Secret whole, with envFrom, at container boot"]

    ProdEnv --> ModProd --> SecProd
    StageEnv --> ModStage --> SecStage
    ProdEnv -.inherited by reference.-> StageEnv
    ModProd -. "guard: refuses the staging endpoint" .-> ModStage
    SecProd --> Pods
    SecStage --> Pods
    DevEnv -. "never touches the cluster" .-> Pods
    Pods -. "a rotated value needs a re-apply plus a rollout restart" .-> K8s
```

The staging overrides are exactly five keys: the Neon DSN, the Clerk domain and JWKS, the payment key and
its webhook secret. Everything else in that environment is a reference to prod, which is why a key added to
prod does not appear in staging until the reference set is regenerated. Both root modules refuse the other
environment's Neon endpoint at plan time, so neither a typo nor a stale inherited value can point one
environment at the other's database.

## Not owned by terraform

These exist and are wired, but no apply creates or repairs them:

| Thing | Owner |
| --- | --- |
| Neon prod and staging projects | created in the Neon console, `destroy MOD=k3s-staging` leaves them |
| Cloudflare tunnel hostname rules | remote-managed tunnel config, never modelled in terraform |
| `staging` and `prod` Infisical environments | dashboard (the CLI cannot create environments) |
| ArgoCD Applications | `apps-of-apps/*.yaml` in the gitops repo, applied by the root app |
| Cluster-level objects (argocd, ingress-nginx, ns `maxterview`) | `infra/k3s`, never the staging module |
