from fastapi.testclient import TestClient

from app.main import app


def test_health():
    # The context manager runs lifespan (init_pool, lazy) — no Postgres needed.
    with TestClient(app) as client:
        res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
