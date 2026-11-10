import os
from fastapi import FastAPI, HTTPException

app = FastAPI()

def _configured() -> bool:
    return bool(os.getenv("XAI_API_KEY") or os.getenv("OPENAI_API_KEY"))

@app.get("/health")
def health():
    return {
        "status": "ok",
        "phase": "1",
        "agents": ["genesis", "savannah", "aria"],
        "keyauthority_integration": "placeholder_ready",
        "credentials_configured": _configured(),
    }

@app.get("/")
def root():
    return {"service": "NEXUS Control Plane", "phase": "1"}

@app.post("/v1/chat/completions")
def chat_completions(body: dict):
    if not _configured():
        raise HTTPException(status_code=503, detail="credentials not configured")
    raise HTTPException(status_code=501, detail="upstream not implemented")
