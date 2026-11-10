"""
Basic Phase 1 automated tests for NEXUS Control Plane
Run with: pytest control-plane/tests/ -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["phase"] == "1"
    assert "genesis" in data["agents"]
    assert "savannah" in data["agents"]
    assert "aria" in data["agents"]
    assert data["keyauthority_integration"] == "placeholder_ready"


def test_root_endpoint():
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "NEXUS Control Plane"
    assert data["phase"] == "1"


def test_chat_completions_fails_closed_without_keys():
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "nexus-primary",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )
    assert response.status_code in (503, 501, 502)
    assert response.status_code != 200


def test_no_secrets_in_health():
    response = client.get("/health")
    body = response.text.lower()
    assert "sk-" not in body
    assert "api_key" not in body or "configured" in body
