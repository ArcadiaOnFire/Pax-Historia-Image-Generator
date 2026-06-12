// ==UserScript==
// @name         Pax Historia Image Gen
// @match        https://paxhistoria.co/*
// @match        https://www.paxhistoria.co/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      openrouter.ai
// @connect      api.openrouter.ai
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

const STATE_KEY = "ph_img_state";

const STATE = {
    engine: "ComfyUI",
    host: "http://127.0.0.1:8188",
    activeWorkflow: null,
    workflows: {},
    textAI: {
        provider: null,
        openrouter: {
            apiKey: "",
            model: "openai/gpt-4o-mini"
        },
        openaiCompatible: {
            endpoint: "http://127.0.0.1:1234/v1/chat/completions",
            apiKey: "",
            model: "local-model"
        }
    },
    visualMemory: {
        enabled: true,
        games: {}
    }
};

const processed = new Set();
const activeRequests = new Set();
const activePollCancels = new Set();
const objectUrls = new Set();

const BTN_ID = "ph-img-gen-btn";
const MODAL_ID = "ph-img-modal";
const VIEW_ID = "ph-img-viewer";
const PREVIEW_CLASS = "ph-img-inline";
const STOP_BTN_ID = "ph-img-stop-btn";
const START_BTN_ID = "ph-img-start-btn";
const CODEX_MODAL_ID = "ph-img-codex-modal";

let stopRequested = false;
let observer = null;
let processRunning = false;
let processQueued = false;
let processTimer = null;
let openRouterCooldownUntil = 0;

function mergeDeep(target, source) {
    for (const key of Object.keys(source || {})) {
        const sv = source[key];
        const tv = target[key];

        if (sv && typeof sv === "object" && !Array.isArray(sv)) {
            if (!tv || typeof tv !== "object" || Array.isArray(tv)) target[key] = {};
            mergeDeep(target[key], sv);
        } else {
            target[key] = sv;
        }
    }

    return target;
}

function normalizeState() {
    if (!STATE.textAI) STATE.textAI = { provider: null, openrouter: {}, openaiCompatible: {} };
    if (STATE.textAI.provider === "disabled") STATE.textAI.provider = null;

    if (STATE.textAI.provider === "lmstudio" || STATE.textAI.provider === "oobabooga") {
        const legacy = STATE.textAI.provider === "lmstudio" ? STATE.textAI.lmstudio : STATE.textAI.oobabooga;

        if (!STATE.textAI.openaiCompatible) {
            STATE.textAI.openaiCompatible = {
                endpoint: "http://127.0.0.1:1234/v1/chat/completions",
                apiKey: "",
                model: "local-model"
            };
        }

        if (legacy?.host) STATE.textAI.openaiCompatible.endpoint = legacy.host;
        if (legacy?.model) STATE.textAI.openaiCompatible.model = legacy.model;
        if (legacy?.apiKey) STATE.textAI.openaiCompatible.apiKey = legacy.apiKey;

        STATE.textAI.provider = "openai-compatible";
    }

    if (!STATE.textAI.openrouter) {
        STATE.textAI.openrouter = {
            apiKey: "",
            model: "openai/gpt-4o-mini"
        };
    }

    if (!STATE.textAI.openaiCompatible) {
        STATE.textAI.openaiCompatible = {
            endpoint: "http://127.0.0.1:1234/v1/chat/completions",
            apiKey: "",
            model: "local-model"
        };
    }

    if (!STATE.visualMemory) STATE.visualMemory = { enabled: true, games: {} };
    if (typeof STATE.visualMemory.enabled !== "boolean") STATE.visualMemory.enabled = true;
    if (!STATE.visualMemory.games || typeof STATE.visualMemory.games !== "object") STATE.visualMemory.games = {};

    for (const gameId of Object.keys(STATE.visualMemory.games)) {
        const mem = STATE.visualMemory.games[gameId] || {};

        if (!mem.characters || typeof mem.characters !== "object") mem.characters = {};
        if (!mem.factions || typeof mem.factions !== "object") mem.factions = {};
        if (!mem.promptCache || typeof mem.promptCache !== "object") mem.promptCache = {};
        if (!mem.meta || typeof mem.meta !== "object") mem.meta = {};

        for (const [key, c] of Object.entries(mem.characters)) {
            const normalized = normalizeCharacterRecord(c, key);
            delete mem.characters[key];
            if (normalized.id) mem.characters[normalized.id] = normalized;
        }

        for (const [key, f] of Object.entries(mem.factions)) {
            const normalized = normalizeFactionRecord(f, key);
            delete mem.factions[key];
            if (normalized.id) mem.factions[normalized.id] = normalized;
        }

        STATE.visualMemory.games[gameId] = mem;
    }
}

function save() {
    normalizeState();
    localStorage.setItem(STATE_KEY, JSON.stringify(STATE));
}

function load() {
    try {
        const r = localStorage.getItem(STATE_KEY);
        if (r) mergeDeep(STATE, JSON.parse(r));
    } catch {}

    normalizeState();
}

load();

function $(q) {
    return document.querySelector(q);
}

function getRef() {
    return document.querySelector('nav li:has(a[href="/games"])');
}

function getGameId() {
    const m = location.pathname.match(/\/game\/([^/?#]+)/i);
    return m ? m[1] : "global";
}

function getGameMemory() {
    normalizeState();

    const id = getGameId();

    if (!STATE.visualMemory.games[id]) {
        STATE.visualMemory.games[id] = {
            characters: {},
            factions: {},
            promptCache: {},
            meta: {
                gameId: id,
                createdAt: new Date().toISOString()
            }
        };
    }

    const mem = STATE.visualMemory.games[id];

    if (!mem.characters) mem.characters = {};
    if (!mem.factions) mem.factions = {};
    if (!mem.promptCache) mem.promptCache = {};
    if (!mem.meta) mem.meta = {};

    mem.meta.gameId = id;
    mem.meta.lastSeenAt = new Date().toISOString();

    return mem;
}

function stableHash(str) {
    let h = 2166136261;

    for (let i = 0; i < String(str).length; i++) {
        h ^= String(str).charCodeAt(i);
        h = Math.imul(h, 16777619);
    }

    return Math.abs(h >>> 0);
}

function normalizeText(s) {
    return String(s || "")
        .replace(/[“”"]/g, "")
        .replace(/[’]/g, "'")
        .replace(/\s+/g, " ")
        .replace(/[.,;:!?]+$/g, "")
        .trim();
}

function titleCaseLoose(name) {
    return normalizeText(name)
        .split(" ")
        .filter(Boolean)
        .map(w => {
            if (w.length <= 2 && w === w.toUpperCase()) return w;
            if (/^[A-Z0-9]+$/.test(w)) return w;
            return w.charAt(0).toUpperCase() + w.slice(1);
        })
        .join(" ");
}

function memorySafeId(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9à-öø-ÿ' -]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function canonicalPersonIdFromAI(item) {
    return memorySafeId(item?.canonicalId || item?.id || item?.name || "");
}

function canonicalFactionIdFromAI(item) {
    return memorySafeId(item?.canonicalId || item?.id || item?.name || "");
}

function normalizeCharacterRecord(c, fallbackKey = "") {
    const name = titleCaseLoose(c?.name || fallbackKey);
    const id = memorySafeId(c?.canonicalId || c?.id || fallbackKey || name);

    return {
        id,
        canonicalId: id,
        name,
        title: normalizeText(c?.title || ""),
        faction: normalizeText(c?.faction || ""),
        identity: normalizeText(c?.identity || c?.appearance || c?.description || ""),
        marks: normalizeText(c?.marks || c?.notes || ""),
        seed: Number.isFinite(c?.seed) ? c.seed : stableHash(`${getGameId()}::character::${id}`)
    };
}

function normalizeFactionRecord(f, fallbackKey = "") {
    const name = normalizeText(f?.name || fallbackKey);
    const id = memorySafeId(f?.canonicalId || f?.id || fallbackKey || name);

    return {
        id,
        canonicalId: id,
        name,
        colors: normalizeText(f?.colors || ""),
        symbols: normalizeText(f?.symbols || ""),
        visualStyle: normalizeText(f?.visualStyle || f?.architecture || f?.uniforms || ""),
        notes: normalizeText(f?.notes || f?.description || ""),
        seed: Number.isFinite(f?.seed) ? f.seed : stableHash(`${getGameId()}::faction::${id}`)
    };
}

function mergeUsefulText(oldValue, newValue, maxLen = 280) {
    const oldText = normalizeText(oldValue);
    const newText = normalizeText(newValue);

    if (!newText) return oldText;
    if (!oldText) return newText.slice(0, maxLen);
    if (oldText.toLowerCase().includes(newText.toLowerCase())) return oldText;
    if (newText.toLowerCase().includes(oldText.toLowerCase())) return newText.slice(0, maxLen);

    return `${oldText}; ${newText}`.slice(0, maxLen);
}

function addTextAICodex(parsed) {
    if (!STATE.visualMemory.enabled || !STATE.textAI.provider) return;

    const mem = getGameMemory();
    let changed = false;

    const chars = Array.isArray(parsed?.codex?.characters)
        ? parsed.codex.characters
        : [];

    const factions = Array.isArray(parsed?.codex?.factions)
        ? parsed.codex.factions
        : [];

    for (const item of chars) {
        if (!item?.name) continue;

        const id = canonicalPersonIdFromAI(item);
        if (!id) continue;

        const rec = normalizeCharacterRecord({
            id,
            canonicalId: id,
            name: item.name,
            title: item.title || "",
            faction: item.faction || "",
            identity: item.identity || "",
            marks: item.marks || ""
        });

        if (!mem.characters[id]) {
            mem.characters[id] = rec;
            changed = true;
        } else {
            const old = mem.characters[id];

            old.name = old.name || rec.name;
            old.title = old.title || rec.title;
            old.faction = old.faction || rec.faction;
            old.identity = mergeUsefulText(old.identity, rec.identity);
            old.marks = mergeUsefulText(old.marks, rec.marks, 180);
            old.seed = old.seed || rec.seed;

            changed = true;
        }
    }

    for (const item of factions) {
        if (!item?.name) continue;

        const id = canonicalFactionIdFromAI(item);
        if (!id) continue;

        const rec = normalizeFactionRecord({
            id,
            canonicalId: id,
            name: item.name,
            colors: item.colors || "",
            symbols: item.symbols || "",
            visualStyle: item.visualStyle || "",
            notes: item.notes || ""
        });

        if (!mem.factions[id]) {
            mem.factions[id] = rec;
            changed = true;
        } else {
            const old = mem.factions[id];

            old.name = old.name || rec.name;
            old.colors = mergeUsefulText(old.colors, rec.colors, 120);
            old.symbols = mergeUsefulText(old.symbols, rec.symbols, 160);
            old.visualStyle = mergeUsefulText(old.visualStyle, rec.visualStyle, 220);
            old.notes = mergeUsefulText(old.notes, rec.notes, 180);
            old.seed = old.seed || rec.seed;

            changed = true;
        }
    }

    if (changed) save();
}

function characterCanonLine(c) {
    if (!c) return "";

    const name = [c.title, c.name].filter(Boolean).join(" ");
    const parts = [
        c.identity,
        c.faction ? `associated with ${c.faction}` : "",
        c.marks
    ].filter(Boolean);

    if (!parts.length) return "";
    return `${name}: ${parts.join(", ")}`;
}

function factionCanonLine(f) {
    if (!f) return "";

    const parts = [
        f.colors ? `colors: ${f.colors}` : "",
        f.symbols ? `symbols: ${f.symbols}` : "",
        f.visualStyle ? `visual style: ${f.visualStyle}` : "",
        f.notes
    ].filter(Boolean);

    if (!parts.length) return "";
    return `${f.name}: ${parts.join(", ")}`;
}

function findRelevantMemory(action) {
    const mem = getGameMemory();
    const text = `${action?.title || ""}\n${action?.body || ""}\n${(action?.factions || []).join("\n")}`.toLowerCase();

    const characters = [];
    const factions = [];

    for (const c of Object.values(mem.characters || {})) {
        const rec = normalizeCharacterRecord(c);
        const full = [rec.title, rec.name].filter(Boolean).join(" ").toLowerCase();
        const id = rec.id.toLowerCase();
        const nameParts = rec.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);

        if (
            text.includes(full) ||
            text.includes(id) ||
            nameParts.some(p => text.includes(p))
        ) {
            characters.push(rec);
        }
    }

    for (const f of Object.values(mem.factions || {})) {
        const rec = normalizeFactionRecord(f);
        const direct = (action.factions || []).some(x => memorySafeId(x) === rec.id);
        const mentioned = text.includes(rec.name.toLowerCase()) || text.includes(rec.id);

        if (direct || mentioned) factions.push(rec);
    }

    return {
        characters: characters.slice(0, 6),
        factions: factions.slice(0, 6)
    };
}

function buildCanonPromptText(action) {
    if (!STATE.visualMemory.enabled) return "";

    const relevant = findRelevantMemory(action);
    const lines = [
        ...relevant.characters.map(characterCanonLine).filter(Boolean),
        ...relevant.factions.map(factionCanonLine).filter(Boolean)
    ];

    if (!lines.length) return "";

    return [
        "CANON VISUAL CONTINUITY:",
        ...lines,
        "Preserve stable identity traits. Clothing, pose, lighting, setting, and mood may change based on the current action."
    ].join("\n");
}

function getPromptCacheKey(action, hints) {
    return String(stableHash(JSON.stringify({
        gameId: getGameId(),
        date: action.date || "",
        title: action.title || "",
        body: action.body || "",
        factions: action.factions || [],
        positive: hints?.positivePrompt || "",
        negative: hints?.negativePrompt || "",
        provider: STATE.textAI.provider || "",
        codexEnabled: STATE.visualMemory.enabled
    })));
}

function getCachedRefinement(action, hints) {
    if (!STATE.visualMemory.enabled) return null;

    const mem = getGameMemory();
    const key = getPromptCacheKey(action, hints);
    return mem.promptCache?.[key]?.action || null;
}

function saveCachedRefinement(action, hints, refined) {
    if (!STATE.visualMemory.enabled) return;

    const mem = getGameMemory();
    const key = getPromptCacheKey(action, hints);

    mem.promptCache[key] = {
        action: refined,
        createdAt: new Date().toISOString()
    };

    const entries = Object.entries(mem.promptCache);

    if (entries.length > 120) {
        entries
            .sort((a, b) => String(a[1]?.createdAt || "").localeCompare(String(b[1]?.createdAt || "")))
            .slice(0, entries.length - 120)
            .forEach(([k]) => delete mem.promptCache[k]);
    }

    save();
}

function makeRequestHeadersText(responseHeaders, name) {
    const lines = String(responseHeaders || "").split(/\r?\n/);
    const wanted = name.toLowerCase();

    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;

        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();

        if (k === wanted) return v;
    }

    return "";
}

function ensureButton() {
    const ref = getRef();
    if (!ref) return;

    const existing = $("#" + BTN_ID);

    if (existing) {
        existing.innerText = `IMAGE GENERATION | ${STATE.engine}`;
        return;
    }

    const b = document.createElement("button");
    b.id = BTN_ID;
    b.type = "button";
    b.innerText = `IMAGE GENERATION | ${STATE.engine}`;

    Object.assign(b.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "4px 12px",
        borderRadius: "9999px",
        fontSize: "0.875rem",
        fontWeight: "500",
        cursor: "pointer",
        background: "rgb(40,20,60)",
        color: "#fff",
        border: "none",
        flexShrink: "0"
    });

    b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModal();
    };

    ref.insertAdjacentElement("afterend", b);
}

function getActions() {
    return Array.from(document.querySelectorAll(".animate-in.fade-in.slide-in-from-top-4"));
}

function extract(card) {
    const date =
        card.querySelector(".inline-flex.items-center.rounded-md")
            ?.textContent?.trim() || "";

    const markdowns = card.querySelectorAll(".markdown-content");

    const title = markdowns[0]?.textContent?.trim() || "";
    const body = markdowns[1]?.textContent?.trim() || "";

    const factions = Array.from(
        card.querySelectorAll(".mb-1.flex.flex-wrap.gap-1 span")
    )
    .map(el => el.textContent.trim())
    .filter(Boolean);

    return { date, title, body, factions };
}

function signature(a) {
    return [getGameId(), a.date, a.title, a.body].join("::").slice(0, 700);
}

function getWorkflow() {
    return STATE.activeWorkflow ? STATE.workflows[STATE.activeWorkflow] : null;
}

function safeClone(obj) {
    try {
        return structuredClone(obj);
    } catch {
        return JSON.parse(JSON.stringify(obj));
    }
}

function extractWorkflowPromptHints(workflow) {
    const positives = [];
    const negatives = [];

    for (const node of Object.values(workflow || {})) {
        if (node?.class_type !== "CLIPTextEncode") continue;

        const text = typeof node?.inputs?.text === "string" ? node.inputs.text.trim() : "";
        if (!text) continue;

        const title = String(node?._meta?.title || "").toLowerCase();
        const isNegative = title.includes("negative");

        if (isNegative) negatives.push(text);
        else positives.push(text);
    }

    return {
        positivePrompt: positives.join(", ").trim(),
        negativePrompt: negatives.join(", ").trim()
    };
}

function compressAction(body) {
    if (!body) return "";

    const text = body.replace(/\s+/g, " ").trim();
    const sentences = text.split(/(?<=[.!?])\s+/);
    const visual = [];

    for (const s of sentences) {
        const l = s.toLowerCase();

        if (
            l.includes("analyst") ||
            l.includes("analysts") ||
            l.includes("intelligence report") ||
            l.includes("intelligence reports") ||
            l.includes("privately acknowledge") ||
            l.includes("according to reports") ||
            l.includes("sources indicate") ||
            l.includes("diplomatic note")
        ) continue;

        visual.push(s);
        if (visual.length >= 2) break;
    }

    return visual.join(" ");
}

function inferContextualTags(action) {
    const text = `${action?.title || ""} ${action?.body || ""} ${(action?.factions || []).join(" ")}`.toLowerCase();
    const tags = [];

    if (/\b(person|people|leader|ruler|soldier|officer|diplomat|commander|minister|king|queen|president|emperor|general|captain|agent|spy|warrior|pilot)\b/i.test(text)) {
        tags.push("detailed human subject", "realistic facial features", "period-accurate clothing");
    }

    if (/\b(military|army|soldier|battle|war|frontline|trench|tank|rifle|artillery|airstrike|combat|invasion|occupation|campaign)\b/i.test(text)) {
        tags.push("military realism", "authentic uniforms", "battlefield atmosphere");
    }

    if (/\b(palace|throne|royal|noble|court)\b/i.test(text)) {
        tags.push("regal attire", "ornate interior");
    }

    if (/\b(diplomat|diplomatic|negotiation|treaty|summit|parliament|senate|congress|council|meeting|conference)\b/i.test(text)) {
        tags.push("formal interior", "serious political atmosphere");
    }

    if (/\b(city|street|village|town|capital|market|crowd|protest|riot|square)\b/i.test(text)) {
        tags.push("urban environment detail", "street-level atmosphere");
    }

    if (/\b(fire|smoke|explosion|burning|ruins|wreckage|debris)\b/i.test(text)) {
        tags.push("smoke and debris", "dramatic destruction");
    }

    return [...new Set(tags)];
}

function buildTextAIPrompt(action, hints) {
    const canon = buildCanonPromptText(action);
    const positiveTags = hints?.positivePrompt || "";
    const negativeTags = hints?.negativePrompt || "";

    return `
You convert Pax Historia actions into a single Stable Diffusion / ComfyUI image prompt.

You also maintain an automatic Campaign Codex for visual consistency.

IMPORTANT:
- The script contains NO hardcoded titles, countries, eras, roles, or factions.
- You must interpret the preset/game context from the input only.
- You must provide canonicalId values for merging.
- canonicalId should be stable, lowercase, and title-free when possible.
- For people, canonicalId should usually be the stable personal name, not a rank/title/sentence.
- For factions, canonicalId should be the stable faction/entity name.
- Do not create Codex entries for temporary outfits, pose, lighting, mood, locations, operations, commands, plans, sentences, or one-time scene details.
- Clothing/outfit should go in the prompt only unless it is a permanent identity trait.

Existing Codex canon:
${canon || "(none)"}

Workflow positive tags to include if present:
${positiveTags || "(none)"}

Negative constraints to respect:
${negativeTags || "(none)"}

Return ONLY this JSON:
{
  "prompt": "one clean cinematic image prompt",
  "title": "short image title",
  "factions": ["visible faction names only"],
  "codex": {
    "characters": [
      {
        "canonicalId": "stable lowercase identity key",
        "name": "actual recurring character name only",
        "title": "stable title or role if known from the input",
        "faction": "stable allegiance if known from the input",
        "identity": "stable face/age/hair/build/skin/recognizable identity traits only",
        "marks": "stable scars, facial hair, eyewear, emblem, or other permanent visual identifiers only"
      }
    ],
    "factions": [
      {
        "canonicalId": "stable lowercase faction key",
        "name": "recurring faction name",
        "colors": "stable faction colors only",
        "symbols": "stable flags, emblems, insignia only",
        "visualStyle": "stable architecture, vehicle, equipment, or design language only",
        "notes": "other stable visual identity notes only"
      }
    ]
  }
}

Rules:
- Fully automate useful Codex updates when a recurring character or faction is visible or important.
- Do not include generic filler like "consistent face", "detailed clothing", or "cinematic realism" in Codex fields.
- Character entries must be actual people, not operations, commands, actions, locations, committees, plans, or sentences.
- If unsure whether a name is a person or faction, omit it.
- Outfit and clothing should go in the prompt only, not the Codex.
- The prompt should freely adapt outfit, pose, lighting, environment, and mood to this specific action.
- No hardcoded countries, periods, or historical assumptions unless present in the input.
- No metadata, timestamps, source fields, cache fields, seed numbers, or internal notes.
- Existing Codex identity traits override your creativity.

Input:
Date: ${action.date}
Title: ${action.title}
Body: ${action.body}
Factions: ${(action.factions || []).join(", ")}
`;
}

async function callOpenRouter(prompt) {
    const cfg = STATE.textAI.openrouter;
    if (!cfg.apiKey) throw new Error("Missing OpenRouter API key");

    const now = Date.now();

    if (openRouterCooldownUntil && now < openRouterCooldownUntil) {
        throw new Error(`OpenRouter cooldown active for ${Math.ceil((openRouterCooldownUntil - now) / 1000)}s`);
    }

    const r = await makeRequest({
        method: "POST",
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cfg.apiKey}`,
            "HTTP-Referer": location.origin,
            "X-Title": "Pax Historia Image Gen"
        },
        data: JSON.stringify({
            model: cfg.model,
            messages: [
                {
                    role: "system",
                    content: "Return JSON only. Maintain automatic visual identity fields only. Do not rely on hardcoded presets. No metadata."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.2
        }),
        timeout: 30000
    });

    if (r.status === 429) {
        const retryAfter = parseInt(makeRequestHeadersText(r.responseHeaders, "retry-after"), 10);
        const cooldownMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 45000;
        openRouterCooldownUntil = Date.now() + cooldownMs;
        throw new Error(`OpenRouter 429 rate limited`);
    }

    if (r.status < 200 || r.status >= 300) {
        throw new Error(`OpenRouter HTTP ${r.status}: ${String(r.responseText || "").slice(0, 300)}`);
    }

    const data = JSON.parse(r.responseText || "{}");
    return data.choices?.[0]?.message?.content || "";
}

async function callOpenAICompatible(prompt) {
    const cfg = STATE.textAI.openaiCompatible;
    const endpoint = normalizeCompatibleEndpoint(cfg.endpoint);

    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

    const r = await makeRequest({
        method: "POST",
        url: endpoint,
        headers,
        data: JSON.stringify({
            model: cfg.model,
            messages: [
                {
                    role: "system",
                    content: "Return JSON only. Maintain automatic visual identity fields only. Do not rely on hardcoded presets. No metadata."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.2
        }),
        timeout: 30000
    });

    if (r.status < 200 || r.status >= 300) {
        throw new Error(`OpenAI-compatible HTTP ${r.status}: ${String(r.responseText || "").slice(0, 300)}`);
    }

    const data = JSON.parse(r.responseText || "{}");
    return data.choices?.[0]?.message?.content || "";
}

function normalizeCompatibleEndpoint(endpoint) {
    let e = String(endpoint || "").trim();

    if (!e) return "http://127.0.0.1:1234/v1/chat/completions";
    if (e.endsWith("/chat/completions")) return e;
    if (e.endsWith("/v1")) return `${e}/chat/completions`;
    if (e.endsWith("/")) return `${e}v1/chat/completions`;

    return `${e}/v1/chat/completions`;
}

function stripCodeFences(text) {
    return String(text || "").replace(/```json|```/g, "").trim();
}

function extractJSONObject(text) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");

    if (first !== -1 && last !== -1 && last > first) {
        return cleaned.slice(first, last + 1);
    }

    return cleaned;
}

function sanitizeGeneratedPrompt(prompt) {
    return String(prompt || "")
        .replace(/\{[\s\S]*?\}/g, "")
        .replace(/\bconsistent face\b/gi, "")
        .replace(/\bcreatedAt\b|\bupdatedAt\b|\bsource\b|\bseed\b|\bstatus\b|\bcache\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

async function refineActionWithTextAI(action, hints) {
    if (stopRequested) return action;

    const cached = getCachedRefinement(action, hints);
    if (cached) return cached;

    if (!STATE.textAI.provider) {
        const fallback = enhanceRawActionWithCanon(action);
        saveCachedRefinement(action, hints, fallback);
        return fallback;
    }

    try {
        const prompt = buildTextAIPrompt(action, hints);
        let raw = "";

        if (STATE.textAI.provider === "openrouter") {
            raw = await callOpenRouter(prompt);
        } else if (STATE.textAI.provider === "openai-compatible") {
            raw = await callOpenAICompatible(prompt);
        } else {
            return enhanceRawActionWithCanon(action);
        }

        if (stopRequested) return action;

        const parsed = JSON.parse(extractJSONObject(raw));
        addTextAICodex(parsed);

        const refined = {
            ...action,
            title: sanitizeGeneratedPrompt(parsed.title || action.title),
            factions: Array.isArray(parsed.factions) ? parsed.factions.map(normalizeText).filter(Boolean).slice(0, 4) : action.factions,
            body: sanitizeGeneratedPrompt(parsed.prompt || action.body)
        };

        saveCachedRefinement(action, hints, refined);
        return refined;
    } catch (e) {
        if (!stopRequested) console.warn("Text AI failed, fallback to raw action:", e);

        const fallback = enhanceRawActionWithCanon(action);
        saveCachedRefinement(action, hints, fallback);
        return fallback;
    }
}

function enhanceRawActionWithCanon(action) {
    const canon = buildCanonPromptText(action);
    if (!canon) return action;

    return {
        ...action,
        body: `${action.body || ""}\n\n${canon}`.trim()
    };
}

function buildPrompt(action, hints) {
    const visual = compressAction(action.body);
    const canon = buildCanonPromptText(action);

    let factions = action.factions || [];
    factions = factions.filter(f => !/^god$/i.test(f)).slice(0, 4);

    const factionText = factions.length ? `${factions.join(", ")}.` : "";
    const title = normalizeText(action.title).slice(0, 120);
    const styleTags = hints?.positivePrompt || "";
    const inferredTags = inferContextualTags(action).join(", ");

    return [
        action.date ? `${action.date}.` : "",
        factionText,
        title,
        visual,
        canon,
        inferredTags,
        styleTags,
        "cinematic wide shot",
        "realistic environment",
        "high detail",
        "soft natural lighting"
    ]
    .filter(Boolean)
    .join("\n");
}

function pickCanonicalSeed(action) {
    if (!STATE.visualMemory.enabled) return null;

    const relevant = findRelevantMemory(action);

    if (relevant.characters.length && relevant.characters[0]?.seed) {
        return Number(relevant.characters[0].seed);
    }

    if (relevant.factions.length && relevant.factions[0]?.seed) {
        return Number(relevant.factions[0].seed);
    }

    if (action?.factions?.length) {
        return stableHash(`${getGameId()}::${action.factions[0]}`);
    }

    return stableHash(`${getGameId()}::${action?.title || ""}`);
}

function applySeedToWorkflow(wf, seed) {
    if (!Number.isFinite(seed)) return;

    const normalizedSeed = Math.max(1, Math.floor(seed) % 2147483647);

    for (const node of Object.values(wf || {})) {
        if (!node?.inputs || !node?.class_type) continue;

        const type = String(node.class_type).toLowerCase();

        if (
            type.includes("ksampler") ||
            type.includes("sampler") ||
            Object.prototype.hasOwnProperty.call(node.inputs, "seed") ||
            Object.prototype.hasOwnProperty.call(node.inputs, "noise_seed")
        ) {
            if (Object.prototype.hasOwnProperty.call(node.inputs, "seed")) node.inputs.seed = normalizedSeed;
            if (Object.prototype.hasOwnProperty.call(node.inputs, "noise_seed")) node.inputs.noise_seed = normalizedSeed;
        }
    }
}

function buildWorkflow(action) {
    const base = getWorkflow();
    if (!base) return null;

    const hints = extractWorkflowPromptHints(base);
    const wf = safeClone(base);
    const prompt = buildPrompt(action, hints);

    let targetNode = null;

    for (const node of Object.values(wf)) {
        if (!node?.class_type) continue;

        if (node.class_type === "CLIPTextEncode" && node.inputs) {
            const title = String(node?._meta?.title || "").toLowerCase();
            const isNegative = title.includes("negative");
            const isPositive = title.includes("positive") || !isNegative;

            if (isPositive && typeof node.inputs.text === "string") {
                targetNode = node;
                break;
            }
        }
    }

    if (!targetNode && wf["6"]?.inputs?.text !== undefined) targetNode = wf["6"];
    if (!targetNode) return null;

    targetNode.inputs.text = prompt;

    applySeedToWorkflow(wf, pickCanonicalSeed(action));

    return wf;
}

function buildComfyUrl(pathname) {
    try {
        return new URL(pathname, STATE.host).toString();
    } catch {
        return STATE.host.replace(/\/+$/, "") + pathname;
    }
}

function buildViewUrl(img) {
    const url = new URL(buildComfyUrl("/view"));

    url.searchParams.set("filename", img?.filename || "");
    url.searchParams.set("type", img?.type || "output");
    url.searchParams.set("subfolder", img?.subfolder == null ? "" : String(img.subfolder));

    return url.toString();
}

async function send(wf) {
    const r = await makeRequest({
        method: "POST",
        url: buildComfyUrl("/prompt"),
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ prompt: wf }),
        timeout: 30000
    });

    if (r.status < 200 || r.status >= 300) {
        throw new Error(`ComfyUI /prompt HTTP ${r.status}: ${String(r.responseText || "").slice(0, 300)}`);
    }

    return JSON.parse(r.responseText || "{}");
}

function pollResult(promptId) {
    return new Promise((resolve, reject) => {
        if (stopRequested) {
            reject(new Error("stopped"));
            return;
        }

        let tries = 0;
        let settled = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            activePollCancels.delete(cancel);
        };

        const finishResolve = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };

        const cancel = () => finishReject(new Error("stopped"));
        activePollCancels.add(cancel);

        const tick = async () => {
            if (settled) return;
            if (stopRequested) return finishReject(new Error("stopped"));

            tries++;

            try {
                const r = await makeRequest({
                    method: "GET",
                    url: buildComfyUrl(`/history/${encodeURIComponent(promptId)}`),
                    timeout: 10000
                });

                if (stopRequested) return finishReject(new Error("stopped"));

                if (r.status < 200 || r.status >= 300) {
                    throw new Error(`ComfyUI /history HTTP ${r.status}`);
                }

                const data = JSON.parse(r.responseText || "{}");

                let entry =
                    data?.[promptId] ||
                    data?.[String(promptId)] ||
                    null;

                if (!entry && data && typeof data === "object") {
                    entry = Object.values(data).find(v => {
                        const pid = String(v?.prompt_id || "");
                        return pid === String(promptId) || (v?.outputs && v?.status);
                    }) || null;
                }

                if (entry) {
                    const status = entry?.status?.status_str;

                    if (status === "error" || status === "canceled") {
                        return finishReject(new Error("ComfyUI error"));
                    }

                    const outputs = entry?.outputs;

                    if (outputs) {
                        for (const k in outputs) {
                            const imgs = outputs[k]?.images;
                            if (imgs?.length) {
                                return finishResolve(buildViewUrl(imgs[0]));
                            }
                        }
                    }
                }
            } catch (e) {
                if (stopRequested) return finishReject(new Error("stopped"));
                console.warn("ComfyUI poll tick failed:", e);
            }

            if (tries > 60) return finishReject(new Error("timeout"));

            timer = setTimeout(tick, 2000);
        };

        tick();
    });
}

function ensurePreview(id) {
    let el = document.querySelector(`[data-ph-img="${CSS.escape(id)}"]`);
    if (el) return el;

    el = document.createElement("div");
    el.className = PREVIEW_CLASS;
    el.dataset.phImg = id;

    Object.assign(el.style, {
        marginTop: "12px",
        marginLeft: "auto",
        marginRight: "auto",
        padding: "10px",
        borderRadius: "12px",
        background: "rgba(20,20,20,0.75)",
        color: "#fff",
        fontSize: "12px",
        maxWidth: "420px",
        width: "100%",
        boxSizing: "border-box",
        textAlign: "center"
    });

    el.innerHTML = "Generating image...";
    return el;
}

function openViewer(url) {
    let m = $("#" + VIEW_ID);
    if (m) m.remove();

    m = document.createElement("div");
    m.id = VIEW_ID;

    Object.assign(m.style, {
        position: "fixed",
        inset: "0",
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999999
    });

    const img = document.createElement("img");
    img.src = url;

    Object.assign(img.style, {
        maxWidth: "95vw",
        maxHeight: "95vh",
        borderRadius: "10px"
    });

    m.onclick = () => m.remove();
    m.appendChild(img);
    document.body.appendChild(m);
}

function attachInline(card, preview) {
    if (preview.parentElement !== card) card.appendChild(preview);
}

function styleField(el) {
    Object.assign(el.style, {
        width: "100%",
        boxSizing: "border-box",
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(255,255,255,0.06)",
        color: "#fff",
        outline: "none",
        fontSize: "13px",
        marginBottom: "8px"
    });
}

function styleButton(el, variant = "default") {
    Object.assign(el.style, {
        padding: "10px 12px",
        borderRadius: "10px",
        border: "none",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: "600",
        color: "#fff",
        background: variant === "danger"
            ? "rgba(160,50,60,0.95)"
            : variant === "start"
                ? "rgba(45,130,75,0.95)"
                : variant === "gold"
                    ? "rgba(150,105,35,0.95)"
                    : variant === "muted"
                        ? "rgba(255,255,255,0.10)"
                        : "rgb(40,20,60)"
    });
}

function styleSection(el) {
    Object.assign(el.style, {
        padding: "12px",
        borderRadius: "12px",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        marginBottom: "10px"
    });
}

function renderWorkflowList(selectEl, statusEl, deleteBtn) {
    selectEl.innerHTML = "";

    const names = Object.keys(STATE.workflows);

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = names.length ? "Select workflow..." : "No workflows loaded";
    selectEl.appendChild(placeholder);

    for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name + (name === STATE.activeWorkflow ? " (active)" : "");
        selectEl.appendChild(opt);
    }

    selectEl.value = STATE.activeWorkflow || "";
    deleteBtn.disabled = !selectEl.value;

    statusEl.textContent = names.length
        ? `${names.length} workflow${names.length === 1 ? "" : "s"} saved`
        : "No workflows saved";
}

function renderTextAISection(container) {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.textContent = "Text AI";
    Object.assign(title.style, {
        fontSize: "15px",
        fontWeight: "700",
        marginBottom: "10px"
    });

    const providerLabel = document.createElement("label");
    providerLabel.textContent = "Provider";
    Object.assign(providerLabel.style, {
        display: "block",
        marginBottom: "6px",
        fontWeight: "600"
    });

    const provider = document.createElement("select");
    provider.id = "ai_provider";
    provider.innerHTML = `
        <option value="">Disabled</option>
        <option value="openrouter">OpenRouter</option>
        <option value="openai-compatible">OpenAI Compatible</option>
    `;
    styleField(provider);
    provider.value = STATE.textAI.provider || "";

    const fields = document.createElement("div");
    fields.style.marginTop = "10px";

    function renderFields() {
        fields.innerHTML = "";
        const p = provider.value;

        if (p === "openrouter") {
            const apiKey = document.createElement("input");
            apiKey.type = "password";
            apiKey.placeholder = "API Key";
            apiKey.value = STATE.textAI.openrouter.apiKey || "";
            styleField(apiKey);

            const model = document.createElement("input");
            model.type = "text";
            model.placeholder = "Model";
            model.value = STATE.textAI.openrouter.model || "";
            styleField(model);

            apiKey.oninput = e => {
                STATE.textAI.openrouter.apiKey = e.target.value;
                save();
            };

            model.oninput = e => {
                STATE.textAI.openrouter.model = e.target.value;
                save();
            };

            fields.appendChild(apiKey);
            fields.appendChild(model);
        }

        if (p === "openai-compatible") {
            const endpoint = document.createElement("input");
            endpoint.type = "text";
            endpoint.placeholder = "Endpoint URL";
            endpoint.value = STATE.textAI.openaiCompatible.endpoint || "";
            styleField(endpoint);

            const apiKey = document.createElement("input");
            apiKey.type = "password";
            apiKey.placeholder = "API Key (optional)";
            apiKey.value = STATE.textAI.openaiCompatible.apiKey || "";
            styleField(apiKey);

            const model = document.createElement("input");
            model.type = "text";
            model.placeholder = "Model";
            model.value = STATE.textAI.openaiCompatible.model || "";
            styleField(model);

            endpoint.oninput = e => {
                STATE.textAI.openaiCompatible.endpoint = e.target.value;
                save();
            };

            apiKey.oninput = e => {
                STATE.textAI.openaiCompatible.apiKey = e.target.value;
                save();
            };

            model.oninput = e => {
                STATE.textAI.openaiCompatible.model = e.target.value;
                save();
            };

            fields.appendChild(endpoint);
            fields.appendChild(apiKey);
            fields.appendChild(model);
        }
    }

    provider.onchange = e => {
        STATE.textAI.provider = e.target.value || null;
        openRouterCooldownUntil = 0;
        save();
        renderFields();
    };

    renderFields();

    container.appendChild(title);
    container.appendChild(providerLabel);
    container.appendChild(provider);
    container.appendChild(fields);
}

function field(labelText, value, oninput, placeholder = "") {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, {
        display: "block",
        fontSize: "12px",
        opacity: "0.95"
    });

    const label = document.createElement("div");
    label.textContent = labelText;
    Object.assign(label.style, {
        marginBottom: "4px",
        fontWeight: "700"
    });

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value || "";
    styleField(input);
    input.oninput = e => oninput(e.target.value);

    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
}

function textareaField(labelText, value, oninput, placeholder = "") {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, {
        display: "block",
        fontSize: "12px",
        opacity: "0.95"
    });

    const label = document.createElement("div");
    label.textContent = labelText;
    Object.assign(label.style, {
        marginBottom: "4px",
        fontWeight: "700"
    });

    const input = document.createElement("textarea");
    input.placeholder = placeholder;
    input.value = value || "";

    Object.assign(input.style, {
        width: "100%",
        boxSizing: "border-box",
        minHeight: "68px",
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(255,255,255,0.06)",
        color: "#fff",
        outline: "none",
        fontSize: "13px",
        marginBottom: "8px",
        resize: "vertical"
    });

    input.oninput = e => oninput(e.target.value);

    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
}

function openCodex() {
    let existing = $("#" + CODEX_MODAL_ID);
    if (existing) existing.remove();

    const mem = getGameMemory();

    const m = document.createElement("div");
    m.id = CODEX_MODAL_ID;

    Object.assign(m.style, {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.74)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000000
    });

    const box = document.createElement("div");
    Object.assign(box.style, {
        width: "1040px",
        maxWidth: "96vw",
        maxHeight: "92vh",
        overflow: "auto",
        background: "linear-gradient(180deg, rgba(35,35,40,0.98), rgba(22,22,26,0.98))",
        color: "#fff",
        padding: "18px",
        borderRadius: "16px",
        boxShadow: "0 25px 80px rgba(0,0,0,0.45)",
        fontSize: "13px",
        border: "1px solid rgba(255,255,255,0.08)"
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        alignItems: "center",
        marginBottom: "12px",
        flexWrap: "wrap"
    });

    const title = document.createElement("div");
    title.innerHTML = `<div style="font-size:20px;font-weight:800;">Campaign Codex</div><div style="opacity:.8;font-size:12px;">Game ${getGameId()} — automatic visual identity memory. Edit only to clean or fix.</div>`;

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    styleButton(close, "muted");
    close.onclick = () => m.remove();

    header.appendChild(title);
    header.appendChild(close);

    const tabs = document.createElement("div");
    Object.assign(tabs.style, {
        display: "flex",
        gap: "8px",
        marginBottom: "12px",
        flexWrap: "wrap"
    });

    const content = document.createElement("div");
    let activeTab = "characters";
    const tabButtons = {};

    function makeTab(name, label) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        styleButton(b, name === activeTab ? "gold" : "muted");
        b.onclick = () => {
            activeTab = name;
            render();
        };
        tabButtons[name] = b;
        tabs.appendChild(b);
    }

    makeTab("characters", "Characters");
    makeTab("factions", "Factions");
    makeTab("cleanup", "Cleanup");

    function refreshTabs() {
        for (const [name, b] of Object.entries(tabButtons)) {
            styleButton(b, name === activeTab ? "gold" : "muted");
        }
    }

    function renderCardShell() {
        const grid = document.createElement("div");
        Object.assign(grid.style, {
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))",
            gap: "12px"
        });
        return grid;
    }

    function characterCard(c) {
        const card = document.createElement("div");
        styleSection(card);
        Object.assign(card.style, { marginBottom: "0" });

        const top = document.createElement("div");
        Object.assign(top.style, {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px",
            marginBottom: "10px"
        });

        const name = document.createElement("div");
        name.textContent = [c.title, c.name].filter(Boolean).join(" ") || "Unnamed";
        Object.assign(name.style, {
            fontWeight: "800",
            fontSize: "15px"
        });

        top.appendChild(name);
        card.appendChild(top);

        card.appendChild(field("Canonical ID", c.canonicalId || c.id, v => {
            const oldId = c.id;
            const nextId = memorySafeId(v);
            if (!nextId) return;

            c.id = nextId;
            c.canonicalId = nextId;

            if (nextId !== oldId && !mem.characters[nextId]) {
                delete mem.characters[oldId];
                mem.characters[nextId] = c;
            }

            save();
        }, "stable merge key"));

        card.appendChild(field("Name", c.name, v => {
            c.name = titleCaseLoose(v);
            save();
        }, "Character name"));

        card.appendChild(field("Stable Title / Role", c.title, v => {
            c.title = normalizeText(v);
            save();
        }, "Whatever the game/AI calls this role"));

        card.appendChild(field("Stable Faction / Allegiance", c.faction, v => {
            c.faction = normalizeText(v);
            save();
        }, "Faction or allegiance"));

        card.appendChild(textareaField("Stable Identity", c.identity, v => {
            c.identity = normalizeText(v);
            save();
        }, "Face, age range, hair, build, complexion, permanent identity traits"));

        card.appendChild(textareaField("Stable Marks / Identifiers", c.marks, v => {
            c.marks = normalizeText(v);
            save();
        }, "Scars, facial hair, eyewear, emblem, other permanent identifiers"));

        const row = document.createElement("div");
        Object.assign(row.style, {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            marginTop: "6px"
        });

        const merge = document.createElement("button");
        merge.type = "button";
        merge.textContent = "Merge Into ID...";
        styleButton(merge, "muted");
        merge.onclick = () => {
            const targetIdRaw = prompt("Merge this character into which existing Canonical ID?");
            if (!targetIdRaw) return;

            const targetId = memorySafeId(targetIdRaw);
            if (!targetId || !mem.characters[targetId]) {
                alert("No matching character found.");
                return;
            }

            const target = mem.characters[targetId];
            target.name = target.name || c.name;
            target.title = target.title || c.title;
            target.faction = target.faction || c.faction;
            target.identity = mergeUsefulText(target.identity, c.identity);
            target.marks = mergeUsefulText(target.marks, c.marks);

            delete mem.characters[c.id];
            save();
            render();
        };

        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Delete";
        styleButton(del, "danger");
        del.onclick = () => {
            if (!confirm(`Delete ${c.name}?`)) return;
            delete mem.characters[c.id];
            save();
            render();
        };

        row.appendChild(merge);
        row.appendChild(del);

        card.appendChild(row);

        return card;
    }

    function factionCard(f) {
        const card = document.createElement("div");
        styleSection(card);
        Object.assign(card.style, { marginBottom: "0" });

        const top = document.createElement("div");
        Object.assign(top.style, {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px",
            marginBottom: "10px"
        });

        const name = document.createElement("div");
        name.textContent = f.name || "Unnamed faction";
        Object.assign(name.style, {
            fontWeight: "800",
            fontSize: "15px"
        });

        top.appendChild(name);
        card.appendChild(top);

        card.appendChild(field("Canonical ID", f.canonicalId || f.id, v => {
            const oldId = f.id;
            const nextId = memorySafeId(v);
            if (!nextId) return;

            f.id = nextId;
            f.canonicalId = nextId;

            if (nextId !== oldId && !mem.factions[nextId]) {
                delete mem.factions[oldId];
                mem.factions[nextId] = f;
            }

            save();
        }, "stable merge key"));

        card.appendChild(field("Faction Name", f.name, v => {
            f.name = normalizeText(v);
            save();
        }, "Faction name"));

        card.appendChild(field("Stable Colors", f.colors, v => {
            f.colors = normalizeText(v);
            save();
        }, "Recurring colors"));

        card.appendChild(field("Stable Symbols", f.symbols, v => {
            f.symbols = normalizeText(v);
            save();
        }, "Flags, emblems, insignia"));

        card.appendChild(textareaField("Stable Visual Style", f.visualStyle, v => {
            f.visualStyle = normalizeText(v);
            save();
        }, "Architecture, vehicles, equipment, design language"));

        card.appendChild(textareaField("Notes", f.notes, v => {
            f.notes = normalizeText(v);
            save();
        }, "Other stable faction identity notes"));

        const row = document.createElement("div");
        Object.assign(row.style, {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            marginTop: "6px"
        });

        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Delete";
        styleButton(del, "danger");
        del.onclick = () => {
            if (!confirm(`Delete ${f.name}?`)) return;
            delete mem.factions[f.id];
            save();
            render();
        };

        row.appendChild(del);
        card.appendChild(row);

        return card;
    }

    function renderCharacters() {
        const wrap = document.createElement("div");

        const controls = document.createElement("div");
        Object.assign(controls.style, {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            marginBottom: "12px"
        });

        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "Add Character";
        styleButton(add, "gold");
        add.onclick = () => {
            const name = prompt("Character name?");
            if (!name) return;

            const id = memorySafeId(name);
            if (!id) return;

            mem.characters[id] = normalizeCharacterRecord({
                id,
                canonicalId: id,
                name,
                seed: stableHash(`${getGameId()}::character::${id}`)
            });

            save();
            render();
        };

        controls.appendChild(add);
        wrap.appendChild(controls);

        const grid = renderCardShell();
        const chars = Object.values(mem.characters).map(normalizeCharacterRecord)
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!chars.length) {
            const empty = document.createElement("div");
            empty.textContent = STATE.textAI.provider
                ? "No characters stored yet. Text AI will automatically add stable recurring identities as actions generate."
                : "No characters stored yet. Enable Text AI for automatic identity memory, or add characters manually.";
            Object.assign(empty.style, { opacity: "0.8", padding: "12px" });
            wrap.appendChild(empty);
            return wrap;
        }

        for (const c of chars) grid.appendChild(characterCard(c));
        wrap.appendChild(grid);
        return wrap;
    }

    function renderFactions() {
        const wrap = document.createElement("div");

        const controls = document.createElement("div");
        Object.assign(controls.style, {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            marginBottom: "12px"
        });

        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "Add Faction";
        styleButton(add, "gold");
        add.onclick = () => {
            const name = prompt("Faction name?");
            if (!name) return;

            const id = memorySafeId(name);

            mem.factions[id] = normalizeFactionRecord({
                id,
                canonicalId: id,
                name,
                seed: stableHash(`${getGameId()}::faction::${id}`)
            });

            save();
            render();
        };

        controls.appendChild(add);
        wrap.appendChild(controls);

        const grid = renderCardShell();
        const factions = Object.values(mem.factions).map(normalizeFactionRecord)
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!factions.length) {
            const empty = document.createElement("div");
            empty.textContent = STATE.textAI.provider
                ? "No factions stored yet. Text AI will automatically add recurring faction identities as actions generate."
                : "No factions stored yet. Enable Text AI for automatic faction memory, or add factions manually.";
            Object.assign(empty.style, { opacity: "0.8", padding: "12px" });
            wrap.appendChild(empty);
            return wrap;
        }

        for (const f of factions) grid.appendChild(factionCard(f));
        wrap.appendChild(grid);
        return wrap;
    }

    function renderCleanup() {
        const wrap = document.createElement("div");
        styleSection(wrap);

        const info = document.createElement("div");
        info.innerHTML = `
            <div style="font-weight:800;font-size:15px;margin-bottom:8px;">Codex Maintenance</div>
            <div style="opacity:.82;line-height:1.45;margin-bottom:12px;">
                The Codex is fully automatic when Text AI is enabled. Use this only for cleanup, merges, and fixes.
            </div>
        `;

        const row = document.createElement("div");
        Object.assign(row.style, {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap"
        });

        const clearCache = document.createElement("button");
        clearCache.type = "button";
        clearCache.textContent = "Clear Prompt Cache";
        styleButton(clearCache, "muted");
        clearCache.onclick = () => {
            mem.promptCache = {};
            save();
            alert("Prompt cache cleared.");
        };

        const clearAll = document.createElement("button");
        clearAll.type = "button";
        clearAll.textContent = "Clear Entire Game Codex";
        styleButton(clearAll, "danger");
        clearAll.onclick = () => {
            if (!confirm("Clear the entire Campaign Codex for this game?")) return;
            delete STATE.visualMemory.games[getGameId()];
            save();
            m.remove();
            openCodex();
        };

        row.appendChild(clearCache);
        row.appendChild(clearAll);

        wrap.appendChild(info);
        wrap.appendChild(row);

        return wrap;
    }

    function render() {
        normalizeState();
        refreshTabs();
        content.innerHTML = "";

        if (activeTab === "characters") content.appendChild(renderCharacters());
        if (activeTab === "factions") content.appendChild(renderFactions());
        if (activeTab === "cleanup") content.appendChild(renderCleanup());
    }

    function refreshTabs() {
        for (const [name, b] of Object.entries(tabButtons)) {
            styleButton(b, name === activeTab ? "gold" : "muted");
        }
    }

    box.appendChild(header);
    box.appendChild(tabs);
    box.appendChild(content);
    m.appendChild(box);
    document.body.appendChild(m);

    render();
}

async function testComfyUIConnection() {
    try {
        const r = await makeRequest({
            method: "GET",
            url: buildComfyUrl("/system_stats"),
            timeout: 8000
        });

        if (r.status >= 200 && r.status < 300) return "ComfyUI: OK";
        return `ComfyUI: FAIL (${r.status})`;
    } catch {
        if (stopRequested) return "ComfyUI: STOPPED";
        return "ComfyUI: FAIL";
    }
}

async function testOpenRouterConnection() {
    const cfg = STATE.textAI.openrouter;
    if (!cfg?.apiKey) return "Text AI (OpenRouter): SKIPPED (missing API key)";

    try {
        const r = await makeRequest({
            method: "POST",
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cfg.apiKey}`,
                "HTTP-Referer": location.origin,
                "X-Title": "Pax Historia Image Gen"
            },
            data: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: "system", content: "Return only the word OK." },
                    { role: "user", content: "ping" }
                ],
                max_tokens: 5,
                temperature: 0
            }),
            timeout: 15000
        });

        if (r.status >= 200 && r.status < 300) return "Text AI (OpenRouter): OK";
        if (r.status === 429) return "Text AI (OpenRouter): FAIL (429 rate limited)";
        return `Text AI (OpenRouter): FAIL (${r.status})`;
    } catch {
        if (stopRequested) return "Text AI (OpenRouter): STOPPED";
        return "Text AI (OpenRouter): FAIL";
    }
}

async function testOpenAICompatibleConnection() {
    const cfg = STATE.textAI.openaiCompatible;
    const endpoint = normalizeCompatibleEndpoint(cfg.endpoint);

    try {
        const headers = { "Content-Type": "application/json" };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

        const r = await makeRequest({
            method: "POST",
            url: endpoint,
            headers,
            data: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: "system", content: "Return only the word OK." },
                    { role: "user", content: "ping" }
                ],
                max_tokens: 5,
                temperature: 0
            }),
            timeout: 15000
        });

        if (r.status >= 200 && r.status < 300) return "Text AI (OpenAI Compatible): OK";
        return `Text AI (OpenAI Compatible): FAIL (${r.status})`;
    } catch {
        if (stopRequested) return "Text AI (OpenAI Compatible): STOPPED";
        return "Text AI (OpenAI Compatible): FAIL";
    }
}

async function testComfyUIImageBlobLoad() {
    try {
        const r = await makeRequest({
            method: "GET",
            url: buildComfyUrl("/history"),
            timeout: 8000
        });

        if (r.status >= 200 && r.status < 300) {
            return "Image preview method: CSP-safe blob loader enabled";
        }

        return `Image preview method: blob loader enabled, history check failed (${r.status})`;
    } catch {
        if (stopRequested) return "Image preview method: STOPPED";
        return "Image preview method: blob loader enabled";
    }
}

async function runConnectionTest() {
    const results = [];
    results.push(await testComfyUIConnection());

    if (STATE.textAI.provider === "openrouter") {
        results.push(await testOpenRouterConnection());
    } else if (STATE.textAI.provider === "openai-compatible") {
        results.push(await testOpenAICompatibleConnection());
    } else {
        results.push("Text AI: DISABLED");
    }

    results.push(await testComfyUIImageBlobLoad());
    results.push(STATE.activeWorkflow ? "Workflow: Loaded" : "Workflow: Not loaded");

    const mem = getGameMemory();
    const charCount = Object.values(mem.characters).length;
    const factionCount = Object.values(mem.factions).length;

    results.push(`Campaign Codex: ${STATE.visualMemory.enabled ? "ON" : "OFF"} (${charCount} characters, ${factionCount} factions)`);
    results.push(`Game ID: ${getGameId()}`);

    alert(results.join("\n"));
}

function startScript() {
    stopRequested = false;

    const stopBtn = $("#" + STOP_BTN_ID);
    if (stopBtn) {
        stopBtn.textContent = "STOP";
        stopBtn.disabled = false;
        stopBtn.style.opacity = "";
        stopBtn.style.cursor = "";
    }

    if (!observer) {
        observer = new MutationObserver(() => {
            scheduleProcess(500);
        });
    }

    try {
        observer.observe(document.body, { childList: true, subtree: true });
    } catch {}

    scheduleProcess(100);
}

function openModal() {
    let m = $("#" + MODAL_ID);

    if (m) {
        m.style.display = "flex";
        return;
    }

    m = document.createElement("div");
    m.id = MODAL_ID;

    Object.assign(m.style, {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.68)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999
    });

    const box = document.createElement("div");
    Object.assign(box.style, {
        width: "640px",
        maxWidth: "94vw",
        maxHeight: "88vh",
        overflow: "auto",
        background: "linear-gradient(180deg, rgba(35,35,40,0.98), rgba(22,22,26,0.98))",
        color: "#fff",
        padding: "18px",
        borderRadius: "16px",
        boxShadow: "0 25px 80px rgba(0,0,0,0.45)",
        fontSize: "13px",
        border: "1px solid rgba(255,255,255,0.08)"
    });

    const header = document.createElement("div");
    header.textContent = "Image Generation";
    Object.assign(header.style, {
        fontSize: "18px",
        fontWeight: "700",
        marginBottom: "14px"
    });

    const general = document.createElement("div");
    styleSection(general);

    const engineLabel = document.createElement("label");
    engineLabel.textContent = "Engine";
    Object.assign(engineLabel.style, {
        display: "block",
        marginBottom: "6px",
        fontWeight: "600"
    });

    const engine = document.createElement("select");
    engine.id = "engine";
    engine.innerHTML = `
        <option>ComfyUI</option>
        <option>Stable-Diffusion</option>
    `;
    styleField(engine);
    engine.value = STATE.engine;

    const hostLabel = document.createElement("label");
    hostLabel.textContent = "Host";
    Object.assign(hostLabel.style, {
        display: "block",
        margin: "12px 0 6px",
        fontWeight: "600"
    });

    const host = document.createElement("input");
    host.id = "host";
    host.type = "text";
    host.value = STATE.host;
    styleField(host);

    general.appendChild(engineLabel);
    general.appendChild(engine);
    general.appendChild(hostLabel);
    general.appendChild(host);

    const textAISection = document.createElement("div");
    styleSection(textAISection);
    renderTextAISection(textAISection);

    const codexSection = document.createElement("div");
    styleSection(codexSection);

    const codexTitle = document.createElement("div");
    codexTitle.textContent = "Campaign Codex";
    Object.assign(codexTitle.style, {
        fontSize: "15px",
        fontWeight: "700",
        marginBottom: "8px"
    });

    const codexInfo = document.createElement("div");
    const mem = getGameMemory();
    const charCount = Object.values(mem.characters).length;
    const factionCount = Object.values(mem.factions).length;

    codexInfo.textContent = `Game ${getGameId()} | ${charCount} characters | ${factionCount} factions | automatic when Text AI is enabled`;
    Object.assign(codexInfo.style, {
        opacity: "0.85",
        marginBottom: "10px",
        lineHeight: "1.4"
    });

    const codexToggleLabel = document.createElement("label");
    Object.assign(codexToggleLabel.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "10px",
        cursor: "pointer"
    });

    const codexToggle = document.createElement("input");
    codexToggle.type = "checkbox";
    codexToggle.checked = !!STATE.visualMemory.enabled;

    const codexToggleText = document.createElement("span");
    codexToggleText.textContent = "Use Campaign Codex for visual consistency";

    codexToggleLabel.appendChild(codexToggle);
    codexToggleLabel.appendChild(codexToggleText);

    const codexBtns = document.createElement("div");
    Object.assign(codexBtns.style, {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap"
    });

    const openCodexBtn = document.createElement("button");
    openCodexBtn.type = "button";
    openCodexBtn.textContent = "Open Campaign Codex";
    styleButton(openCodexBtn, "gold");

    const clearCacheBtn = document.createElement("button");
    clearCacheBtn.type = "button";
    clearCacheBtn.textContent = "Clear Prompt Cache";
    styleButton(clearCacheBtn, "muted");

    codexBtns.appendChild(openCodexBtn);
    codexBtns.appendChild(clearCacheBtn);

    codexSection.appendChild(codexTitle);
    codexSection.appendChild(codexInfo);
    codexSection.appendChild(codexToggleLabel);
    codexSection.appendChild(codexBtns);

    const wfSection = document.createElement("div");
    styleSection(wfSection);

    const wfLabel = document.createElement("label");
    wfLabel.textContent = "Workflows";
    Object.assign(wfLabel.style, {
        display: "block",
        marginBottom: "6px",
        fontWeight: "600"
    });

    const wfUpload = document.createElement("input");
    wfUpload.type = "file";
    wfUpload.id = "wf";
    wfUpload.style.display = "block";
    wfUpload.style.marginBottom = "10px";

    const wfSelect = document.createElement("select");
    wfSelect.id = "wf_select";
    styleField(wfSelect);

    const wfStatus = document.createElement("div");
    wfStatus.id = "wf_status";
    Object.assign(wfStatus.style, {
        margin: "8px 0 10px",
        opacity: "0.85"
    });

    const wfActions = document.createElement("div");
    Object.assign(wfActions.style, {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap"
    });

    const wfDelete = document.createElement("button");
    wfDelete.type = "button";
    wfDelete.textContent = "Delete Selected";
    styleButton(wfDelete, "danger");

    wfActions.appendChild(wfDelete);

    wfSection.appendChild(wfLabel);
    wfSection.appendChild(wfUpload);
    wfSection.appendChild(wfSelect);
    wfSection.appendChild(wfStatus);
    wfSection.appendChild(wfActions);

    const bottom = document.createElement("div");
    Object.assign(bottom.style, {
        display: "flex",
        justifyContent: "space-between",
        gap: "10px",
        alignItems: "center",
        flexWrap: "wrap"
    });

    const start = document.createElement("button");
    start.type = "button";
    start.id = START_BTN_ID;
    start.textContent = "START";
    styleButton(start, "start");

    const stop = document.createElement("button");
    stop.type = "button";
    stop.id = STOP_BTN_ID;
    stop.textContent = stopRequested ? "STOPPED" : "STOP";
    styleButton(stop, "danger");

    const test = document.createElement("button");
    test.type = "button";
    test.textContent = "Test Connection";
    styleButton(test, "muted");

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    styleButton(close);

    bottom.appendChild(start);
    bottom.appendChild(stop);
    bottom.appendChild(test);
    bottom.appendChild(close);

    box.appendChild(header);
    box.appendChild(general);
    box.appendChild(textAISection);
    box.appendChild(codexSection);
    box.appendChild(wfSection);
    box.appendChild(bottom);

    m.appendChild(box);
    document.body.appendChild(m);

    renderWorkflowList(wfSelect, wfStatus, wfDelete);

    engine.onchange = e => {
        STATE.engine = e.target.value;
        save();
        ensureButton();
    };

    host.oninput = e => {
        STATE.host = e.target.value;
        save();
    };

    codexToggle.onchange = e => {
        STATE.visualMemory.enabled = !!e.target.checked;
        save();
    };

    openCodexBtn.onclick = () => openCodex();

    clearCacheBtn.onclick = () => {
        const fresh = getGameMemory();
        fresh.promptCache = {};
        save();
        alert("Prompt cache cleared for this game.");
    };

    wfUpload.onchange = e => {
        const f = e.target.files[0];
        if (!f) return;

        const r = new FileReader();

        r.onload = () => {
            try {
                STATE.workflows[f.name] = JSON.parse(r.result);
                STATE.activeWorkflow = f.name;
                save();
                renderWorkflowList(wfSelect, wfStatus, wfDelete);
                alert("Workflow loaded: " + f.name);
            } catch {
                alert("Workflow error");
            }
        };

        r.readAsText(f);
    };

    wfSelect.onchange = e => {
        STATE.activeWorkflow = e.target.value || null;
        save();
        renderWorkflowList(wfSelect, wfStatus, wfDelete);
    };

    wfDelete.onclick = () => {
        const name = wfSelect.value;
        if (!name) return;

        delete STATE.workflows[name];
        if (STATE.activeWorkflow === name) STATE.activeWorkflow = null;

        save();
        renderWorkflowList(wfSelect, wfStatus, wfDelete);
    };

    start.onclick = () => startScript();
    stop.onclick = () => stopAllRequests();
    test.onclick = () => runConnectionTest();
    close.onclick = () => m.remove();
}

function stopAllRequests() {
    stopRequested = true;

    for (const req of Array.from(activeRequests)) {
        try {
            req.abort();
        } catch {}
    }
    activeRequests.clear();

    for (const cancel of Array.from(activePollCancels)) {
        try {
            cancel();
        } catch {}
    }
    activePollCancels.clear();

    for (const u of Array.from(objectUrls)) {
        try {
            URL.revokeObjectURL(u);
        } catch {}
    }
    objectUrls.clear();

    if (observer) {
        try {
            observer.disconnect();
        } catch {}
    }

    const btn = $("#" + STOP_BTN_ID);
    if (btn) {
        btn.textContent = "STOPPED";
        btn.disabled = true;
        btn.style.opacity = "0.75";
        btn.style.cursor = "not-allowed";
    }
}

function makeRequest(options) {
    return new Promise((resolve, reject) => {
        if (stopRequested) {
            reject(new Error("stopped"));
            return;
        }

        let settled = false;
        let req = null;

        const cleanup = () => {
            if (req && typeof req.abort === "function") {
                activeRequests.delete(req);
            }
        };

        const finishResolve = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };

        req = GM_xmlhttpRequest({
            ...options,
            onload: r => {
                if (stopRequested) return finishReject(new Error("stopped"));
                if (typeof options.onload === "function") {
                    try {
                        const value = options.onload(r);
                        finishResolve(value === undefined ? r : value);
                    } catch (e) {
                        finishReject(e);
                    }
                } else {
                    finishResolve(r);
                }
            },
            onerror: e => {
                if (stopRequested) return finishReject(new Error("stopped"));
                finishReject(e);
            },
            ontimeout: () => {
                if (stopRequested) return finishReject(new Error("stopped"));
                finishReject(new Error("timeout"));
            },
            onabort: () => {
                finishReject(new Error("stopped"));
            }
        });

        if (req && typeof req.abort === "function") {
            activeRequests.add(req);
        }
    });
}

function blobFromComfyUrl(url) {
    return new Promise((resolve, reject) => {
        if (stopRequested) {
            reject(new Error("stopped"));
            return;
        }

        makeRequest({
            method: "GET",
            url,
            responseType: "blob",
            timeout: 20000,
            onload: r => {
                if (r.status < 200 || r.status >= 300) throw new Error(`Image HTTP ${r.status}`);
                return r.response;
            }
        }).then(resolve).catch(reject);
    });
}

function loadImageWithRetry(img, url, preview) {
    let retryCount = 0;
    let lastObjectUrl = null;

    const tryLoad = async () => {
        if (stopRequested) return;

        const bust = `t=${Date.now()}&r=${retryCount}`;
        const bustedUrl = url + (url.includes("?") ? "&" : "?") + bust;

        try {
            const blob = await blobFromComfyUrl(bustedUrl);
            if (stopRequested) return;

            if (lastObjectUrl) {
                URL.revokeObjectURL(lastObjectUrl);
                objectUrls.delete(lastObjectUrl);
            }

            const objectUrl = URL.createObjectURL(blob);
            objectUrls.add(objectUrl);
            lastObjectUrl = objectUrl;

            img.onload = () => {
                preview.dataset.phLoaded = "true";
            };

            img.onerror = e => {
                console.warn("Blob image failed to render:", e, objectUrl);

                if (retryCount < 5) {
                    retryCount++;
                    setTimeout(tryLoad, 1000);
                } else {
                    preview.innerHTML = "Image generated but blob preview failed to render";
                }
            };

            img.src = objectUrl;
        } catch (e) {
            if (stopRequested) return;

            console.warn("Image blob load failed:", e, bustedUrl);

            if (retryCount < 5) {
                retryCount++;
                setTimeout(tryLoad, 1000);
            } else {
                preview.innerHTML = "Image generated but preview failed to load";
            }
        }
    };

    tryLoad();
}

async function process() {
    if (stopRequested) return;

    if (processRunning) {
        processQueued = true;
        return;
    }

    processRunning = true;

    try {
        ensureButton();

        const cards = getActions();
        if (!cards.length) return;

        const baseWorkflow = getWorkflow();
        const hints = extractWorkflowPromptHints(baseWorkflow);

        for (const card of cards) {
            if (stopRequested) return;

            const action = extract(card);
            if (!action.body && !action.title) continue;

            const sig = signature(action);
            if (processed.has(sig)) continue;
            processed.add(sig);

            const preview = ensurePreview(sig);
            attachInline(card, preview);
            preview.innerHTML = "Queued...";

            const refined = await refineActionWithTextAI(action, hints);
            if (stopRequested) return;

            const wf = buildWorkflow(refined);

            if (!wf) {
                preview.innerHTML = "Failed to build image prompt";
                continue;
            }

            try {
                const res = await send(wf);
                if (stopRequested) return;

                const promptId = res?.prompt_id;

                if (!promptId) {
                    preview.innerHTML = "Image request accepted, but no prompt id returned";
                    continue;
                }

                let url = null;

                try {
                    url = await pollResult(promptId);
                } catch (err) {
                    if (stopRequested) return;
                    console.warn("Polling failed but the image may still exist:", err);
                }

                if (stopRequested) return;

                if (url) {
                    const img = document.createElement("img");
                    img.alt = "Generated image";

                    Object.assign(img.style, {
                        display: "block",
                        width: "100%",
                        maxWidth: "100%",
                        margin: "0 auto",
                        borderRadius: "10px",
                        cursor: "pointer"
                    });

                    img.onclick = () => openViewer(img.src);

                    preview.innerHTML = "";
                    preview.appendChild(img);

                    loadImageWithRetry(img, url, preview);
                } else {
                    preview.innerHTML = "Image generated (preview sync failed)";
                }
            } catch (err) {
                if (stopRequested) return;
                console.warn("Image generation request failed:", err);

                if (!preview.querySelector("img")) {
                    preview.innerHTML = "Failed to generate image";
                }
            }
        }
    } finally {
        processRunning = false;

        if (processQueued && !stopRequested) {
            processQueued = false;
            scheduleProcess(500);
        }
    }
}

function scheduleProcess(delay = 500) {
    if (stopRequested) return;

    if (processTimer) {
        clearTimeout(processTimer);
        processTimer = null;
    }

    processTimer = setTimeout(() => {
        processTimer = null;
        process();
    }, delay);
}

function startScript() {
    stopRequested = false;

    const stopBtn = $("#" + STOP_BTN_ID);
    if (stopBtn) {
        stopBtn.textContent = "STOP";
        stopBtn.disabled = false;
        stopBtn.style.opacity = "";
        stopBtn.style.cursor = "";
    }

    if (!observer) {
        observer = new MutationObserver(() => {
            scheduleProcess(500);
        });
    }

    try {
        observer.observe(document.body, { childList: true, subtree: true });
    } catch {}

    scheduleProcess(100);
}

observer = new MutationObserver(() => {
    scheduleProcess(500);
});

observer.observe(document.body, { childList: true, subtree: true });

scheduleProcess(100);

})();
