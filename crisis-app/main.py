"""Crisis Support Hub — one process, one deploy.

FastAPI serves the JSON API *and* the static PWA, so there is no hardcoded
localhost:8000 for a judge's phone to fail on. All data is in-memory seed data:
no database, no third-party API, nothing to configure at demo time.

Run:  uvicorn main:app --host 0.0.0.0 --port 8000
Docs: http://127.0.0.1:8000/docs
"""
from __future__ import annotations

import itertools
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="Crisis Support Hub",
    version="0.1.0",
    description="Offline-capable crisis support demo: coping strategies, hotlines, anonymous peer support.",
)

# The frontend is served from this same origin, so CORS is only a convenience
# for a separately hosted frontend. Tighten allow_origins before real use.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------
# Seed data. Hotline numbers below are real, publicly published ones.
# The in-person entry is deliberately labelled placeholder data — swap in a
# verified local directory before claiming local coverage.
# --------------------------------------------------------------------------
STRATEGIES = [
    {
        "id": 1,
        "title": "4-7-8 Breathing",
        "duration": "~2 min",
        "steps": [
            "Sit or lie down and let your shoulders drop.",
            "Inhale through the nose for a count of 4.",
            "Hold for a count of 7.",
            "Exhale slowly through the mouth for a count of 8.",
            "Repeat for 4 cycles.",
        ],
    },
    {
        "id": 2,
        "title": "5-4-3-2-1 Grounding",
        "duration": "~3 min",
        "steps": [
            "Name 5 things you can see.",
            "Name 4 things you can touch.",
            "Name 3 things you can hear.",
            "Name 2 things you can smell.",
            "Name 1 thing you can taste.",
        ],
    },
    {
        "id": 3,
        "title": "Cold Water Reset",
        "duration": "~1 min",
        "steps": [
            "Run cold water over your wrists, or splash your face.",
            "Breathe out longer than you breathe in (4 in, 6 out).",
            "Notice the temperature change for 30 seconds.",
        ],
    },
]

RESOURCES = [
    {
        "id": 1, "name": "988 Suicide & Crisis Lifeline", "kind": "hotline",
        "phone": "988", "sms": "988", "url": "https://988lifeline.org",
        "lat": None, "lon": None, "note": "Call or text, 24/7, US",
    },
    {
        "id": 2, "name": "Crisis Text Line", "kind": "text",
        "phone": None, "sms": "741741", "url": "https://www.crisistextline.org",
        "lat": None, "lon": None, "note": "Text HOME to 741741",
    },
    {
        "id": 3, "name": "SAMHSA National Helpline", "kind": "hotline",
        "phone": "1-800-662-4357", "sms": None,
        "url": "https://www.samhsa.gov/find-help/national-helpline",
        "lat": None, "lon": None, "note": "Free, confidential referral service, 24/7",
    },
    {
        "id": 4, "name": "Emergency Services", "kind": "emergency",
        "phone": "911", "sms": None, "url": None,
        "lat": None, "lon": None, "note": "Immediate danger to life or safety",
    },
    {
        "id": 5, "name": "Placeholder Walk-In Clinic", "kind": "in_person",
        "phone": None, "sms": None, "url": None,
        "lat": 40.7306, "lon": -73.9866,
        "note": "Fictional entry used to demo distance sorting — replace with verified local data",
    },
]

POSTS: list[dict] = []
MAX_POSTS = 200
_post_ids = itertools.count(1)


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class PostIn(BaseModel):
    content: str = Field(min_length=1, max_length=500)
    # Set by the client so an offline retry cannot create a duplicate.
    client_id: Optional[str] = Field(default=None, max_length=64)


def _public(post: dict) -> dict:
    return {k: v for k, v in post.items() if k != "client_id"}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return round(2 * radius * math.asin(math.sqrt(a)), 2)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "posts": len(POSTS)}


@app.get("/api/strategies")
def get_strategies() -> dict:
    return {"strategies": STRATEGIES}


@app.get("/api/resources")
def get_resources(
    lat: Optional[float] = None,
    lon: Optional[float] = None,
) -> dict:
    """Hotlines always; in-person entries get a distance when lat/lon are sent."""
    if lat is None or lon is None:
        return {"resources": RESOURCES, "location": None}

    enriched = []
    for res in RESOURCES:
        item = dict(res)
        if res["lat"] is not None and res["lon"] is not None:
            item["distance_km"] = _haversine_km(lat, lon, res["lat"], res["lon"])
        else:
            item["distance_km"] = None
        enriched.append(item)
    enriched.sort(key=lambda r: (r["distance_km"] is None, r["distance_km"] or 0))
    return {"resources": enriched, "location": {"lat": lat, "lon": lon}}


@app.get("/api/bootstrap")
def bootstrap() -> dict:
    """Everything the app needs to run offline, in one cacheable request."""
    return {"strategies": STRATEGIES, "resources": RESOURCES}


@app.get("/api/posts")
def get_posts(limit: int = 50) -> dict:
    limit = max(1, min(limit, MAX_POSTS))
    return {"posts": [_public(p) for p in POSTS[::-1][:limit]]}


@app.post("/api/posts", status_code=201)
def create_post(payload: PostIn):
    content = payload.content.strip()
    if not content:
        return JSONResponse({"detail": "content must not be blank"}, status_code=422)

    if payload.client_id:
        for existing in POSTS:  # idempotent retry from the offline outbox
            if existing["client_id"] == payload.client_id:
                return _public(existing)

    post = {
        "id": next(_post_ids),
        "content": content,
        "replies": 0,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "client_id": payload.client_id,
    }
    POSTS.append(post)
    del POSTS[:-MAX_POSTS]  # keep memory bounded
    return _public(post)


# --------------------------------------------------------------------------
# Static PWA (mounted last so /api/* wins)
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
