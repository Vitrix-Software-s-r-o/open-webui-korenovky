"""Per-user proxy to email-mcp's REST endpoints.

The browser never sees the upstream Bearer token. For every request, the
router resolves the user's selected model -> its ``server:mcp:email-mcp-*``
tool-server connection -> uses that connection's ``key`` as the upstream
``Authorization``. This is the same mapping the chat backend already uses
when invoking email MCP tools, so per-mailbox scoping in mailboxes.yml is
honoured end-to-end without duplicating policy here.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from open_webui.env import SRC_LOG_LEVELS
from open_webui.models.models import Models
from open_webui.utils.auth import get_verified_user

log = logging.getLogger(__name__)
log.setLevel(SRC_LOG_LEVELS.get("MAIN", logging.INFO))

router = APIRouter()


EMAIL_MCP_REST_URL = os.environ.get("EMAIL_MCP_REST_URL", "http://email:8002").rstrip("/")
EMAIL_TOOL_SERVER_ID_PREFIX = "email-mcp"


def _connection_for_model_toolids(
    request: Request, tool_ids: list[str] | None
) -> dict[str, Any] | None:
    connections = getattr(request.app.state.config, "TOOL_SERVER_CONNECTIONS", []) or []
    if not connections or not tool_ids:
        return None
    wanted = [
        t.split("server:mcp:", 1)[1]
        for t in tool_ids
        if isinstance(t, str)
        and t.startswith("server:mcp:")
        and t.split("server:mcp:", 1)[1].startswith(EMAIL_TOOL_SERVER_ID_PREFIX)
    ]
    if not wanted:
        return None
    for sid in wanted:
        for conn in connections:
            if ((conn or {}).get("info") or {}).get("id") == sid:
                return conn
    return None


async def _resolve_bearer(request: Request, model_id: str | None) -> str:
    if not model_id:
        raise HTTPException(status_code=400, detail="model_id is required")
    model = await Models.get_model_by_id(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found")

    meta = getattr(model, "meta", None)
    if meta is not None and not isinstance(meta, dict):
        meta = meta.model_dump() if hasattr(meta, "model_dump") else dict(meta)
    tool_ids = (meta or {}).get("toolIds") if meta else None

    conn = _connection_for_model_toolids(request, tool_ids)
    if conn is None:
        raise HTTPException(status_code=403, detail=f"Model '{model_id}' has no email-mcp tool-server bound")
    if (conn.get("auth_type") or "bearer") != "bearer":
        raise HTTPException(status_code=500, detail="Email tool server is not configured for bearer auth")
    bearer = conn.get("key") or ""
    if not bearer:
        raise HTTPException(status_code=500, detail="Email tool server has no key configured")
    return bearer


async def _forward(
    method: str,
    path: str,
    bearer: str,
    params: dict[str, Any] | None = None,
) -> Any:
    url = f"{EMAIL_MCP_REST_URL}{path}"
    headers = {"Authorization": f"Bearer {bearer}"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.request(method, url, params=params, headers=headers)
    except httpx.HTTPError as e:
        log.warning("email-mcp %s %s failed: %s", method, path, e)
        raise HTTPException(status_code=502, detail=f"email-mcp unreachable: {e}") from e
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail") or resp.text
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail or "upstream error")
    if not resp.content:
        return {}
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text}


# --- Cards (top-N unread INBOX rows + total count) ---


@router.get("/cards")
async def email_cards(
    request: Request,
    model_id: str = Query(...),
    limit: int = Query(10, ge=1, le=50),
    user=Depends(get_verified_user),
):
    bearer = await _resolve_bearer(request, model_id)
    return await _forward("GET", "/inbox/cards", bearer, params={"limit": limit})


# --- Live folder listing (left pane in EmailInboxDialog) ---


@router.get("/live")
async def email_live(
    request: Request,
    model_id: str = Query(...),
    mailbox_id: str = Query(...),
    folder: str = Query("INBOX"),
    limit: int = Query(50, ge=1, le=200),
    user=Depends(get_verified_user),
):
    bearer = await _resolve_bearer(request, model_id)
    return await _forward(
        "GET",
        "/inbox/live",
        bearer,
        params={"mailbox_id": mailbox_id, "folder": folder, "limit": limit},
    )


# --- IMAP folder list (for the folder selector in the Pošta dialog) ---


@router.get("/folders")
async def email_folders(
    request: Request,
    model_id: str = Query(...),
    mailbox_id: str = Query(...),
    user=Depends(get_verified_user),
):
    """List IMAP folders for a mailbox. Powers the folder Select in the
    inbox-dialog filter strip."""
    bearer = await _resolve_bearer(request, model_id)
    return await _forward("GET", f"/folders/{mailbox_id}", bearer)


# --- Index-backed search (used by the Pošta dialog when any structured
# --- filter is active or the user types a non-trivial query) ---


@router.get("/search")
async def email_search(
    request: Request,
    model_id: str = Query(...),
    mailbox_id: str = Query(...),
    q: list[str] | None = Query(None),
    folder: str | None = Query(None),
    from_address: str | None = Query(None),
    to_address: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    has_attachments: bool | None = Query(None),
    unseen_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort_order: str = Query("desc"),
    user=Depends(get_verified_user),
):
    """Proxy to email-mcp /search, scoped to the caller's single mailbox.

    The upstream endpoint intersects ``mailbox_ids`` with the bearer's
    allowed list and rejects with 403 when the requested mailbox is not
    authorised — so the browser cannot reach other users' mail even if
    it crafts ``mailbox_id`` by hand.
    """
    bearer = await _resolve_bearer(request, model_id)
    params: dict[str, Any] = {
        "mailbox_ids": [mailbox_id],
        "limit": limit,
        "offset": offset,
        "sort_order": sort_order,
        "unseen_only": str(unseen_only).lower(),
    }
    if q:
        params["q"] = q
    if folder:
        params["folder"] = folder
    if from_address:
        params["from_address"] = from_address
    if to_address:
        params["to_address"] = to_address
    if date_from:
        params["date_from"] = date_from
    if date_to:
        params["date_to"] = date_to
    if has_attachments is not None:
        params["has_attachments"] = str(has_attachments).lower()
    return await _forward("GET", "/search", bearer, params=params)


# --- Single-email detail ---


@router.get("/detail")
async def email_detail(
    request: Request,
    model_id: str = Query(...),
    message_id: str = Query(...),
    mailbox_id: str | None = Query(None),
    folder: str | None = Query(None),
    uid: int | None = Query(None),
    user=Depends(get_verified_user),
):
    """Get a single email by ``message_id``. The ``mailbox_id``/``folder``/``uid``
    hints come from the live-list row and enable an IMAP fallback when
    the email isn't indexed in ES yet."""
    bearer = await _resolve_bearer(request, model_id)
    params: dict[str, object] = {}
    if mailbox_id:
        params["mailbox_id"] = mailbox_id
    if folder:
        params["folder"] = folder
    if uid is not None:
        params["uid"] = uid
    return await _forward("GET", f"/email/{message_id}", bearer, params=params or None)


# --- Draft preparation (mint a draft_id; UI mounts EmailDraftDialog with it) ---


class PrepareBody(BaseModel):
    model_id: str
    mailbox_id: str
    to: list[str]
    subject: str
    body: str
    cc: list[str] = []
    bcc: list[str] = []
    attachments: list[dict] = []
    in_reply_to: str | None = None
    references: str | None = None


@router.post("/drafts/prepare")
async def email_prepare_draft(body: PrepareBody, request: Request,
                              user=Depends(get_verified_user)):
    bearer = await _resolve_bearer(request, body.model_id)
    payload = body.model_dump(exclude={"model_id"})
    url = f"{EMAIL_MCP_REST_URL}/drafts/prepare"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=payload,
                                     headers={"Authorization": f"Bearer {bearer}"})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"email-mcp unreachable: {e}") from e
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail") or resp.text
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail or "upstream error")
    return resp.json()


# --- Flag toggles ---


class FlagBody(BaseModel):
    model_id: str
    message_id: str


async def _flag_toggle(request: Request, body: FlagBody, action: str) -> Any:
    bearer = await _resolve_bearer(request, body.model_id)
    return await _forward("POST", f"/email/{body.message_id}/{action}", bearer)


@router.post("/mark_seen")
async def email_route_mark_seen(body: FlagBody, request: Request,
                                user=Depends(get_verified_user)):
    return await _flag_toggle(request, body, "mark_seen")


@router.post("/mark_unseen")
async def email_route_mark_unseen(body: FlagBody, request: Request,
                                  user=Depends(get_verified_user)):
    return await _flag_toggle(request, body, "mark_unseen")


@router.post("/flag")
async def email_route_flag(body: FlagBody, request: Request,
                           user=Depends(get_verified_user)):
    return await _flag_toggle(request, body, "flag")


@router.post("/unflag")
async def email_route_unflag(body: FlagBody, request: Request,
                             user=Depends(get_verified_user)):
    return await _flag_toggle(request, body, "unflag")
