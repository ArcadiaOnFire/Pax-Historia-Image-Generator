// ==UserScript==
// @name         Pax Historia Image Gen
// @match        https://paxhistoria.co/*
// @match        https://www.paxhistoria.co/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
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
    }
};

const processed = new Set();
const BTN_ID = "ph-img-gen-btn";
const MODAL_ID = "ph-img-modal";
const VIEW_ID = "ph-img-viewer";
const PREVIEW_CLASS = "ph-img-inline";

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
        if (legacy && legacy.host) STATE.textAI.openaiCompatible.endpoint = legacy.host;
        if (legacy && legacy.model) STATE.textAI.openaiCompatible.model = legacy.model;
        if (legacy && legacy.apiKey) STATE.textAI.openaiCompatible.apiKey = legacy.apiKey;
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

function ensureButton() {
    const ref = getRef();
    if (!ref) return;
    if ($("#" + BTN_ID)) return;

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

/* =========================
   EXTRACT (UNCHANGED LOGIC)
========================= */
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
    return [a.date, a.title, a.body].join("::").slice(0, 400);
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

/* =========================
   WORKFLOW PROMPT HINTS
========================= */
function extractWorkflowPromptHints(workflow) {
    const positives = [];
    const negatives = [];

    for (const node of Object.values(workflow || {})) {
        if (node?.class_type !== "CLIPTextEncode") continue;
        const text = typeof node?.inputs?.text === "string" ? node.inputs.text.trim() : "";
        if (!text) continue;

        const title = String(node?._meta?.title || "").toLowerCase();
        const isNegative = title.includes("negative");
        const isPositive = title.includes("positive") || (!isNegative && !positives.length);

        if (isNegative) negatives.push(text);
        else if (isPositive) positives.push(text);
        else positives.push(text);
    }

    return {
        positivePrompt: positives.join(", ").trim(),
        negativePrompt: negatives.join(", ").trim()
    };
}

/* =========================
   PROMPT CLEANING
========================= */
function compressAction(body) {
    if (!body) return "";

    let text = body.replace(/\s+/g, " ").trim();
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

/* =========================
   TEXT AI LAYER
========================= */
function buildTextAIPrompt(action, hints) {
    const positiveTags = hints?.positivePrompt || "";
    const negativeTags = hints?.negativePrompt || "";

    return `
You are a VISUAL SCENE COMPRESSOR for Stable Diffusion / ComfyUI.

Your job is NOT to summarize text.

Your job is to convert a narrative game action into ONE frozen cinematic image frame.

========================
CORE TASK
========================
Extract ONLY the most visually intense moment that could exist as a still image.

If multiple events exist, choose ONE moment with the strongest visual clarity.

========================
STRICT OUTPUT RULES
========================
- Output ONLY valid JSON.
- Do NOT include explanations.
- Do NOT include narrative or lore.
- Do NOT describe meaning, politics, or context.
- Do NOT include abstract ideas (tension, influence, diplomacy, etc.).
- If something cannot be seen in an image, it MUST NOT appear.

========================
WORKFLOW STYLE TAGS
========================
Include these exact positive style tags verbatim in the final prompt if present:
${positiveTags || "(none)"}

Respect these negative constraints:
${negativeTags || "(none)"}

========================
OUTPUT FORMAT
========================
{
  "prompt": "string",
  "title": "string",
  "factions": ["string"]
}

========================
PROMPT CONSTRUCTION RULES
========================
The "prompt" field must be a Stable Diffusion / ComfyUI-ready prompt.

It MUST follow this structure internally:

[SUBJECT] + [ACTION] + [ENVIRONMENT] + [CAMERA] + [LIGHTING] + [STYLE]

Rules:
- Subject must be concrete (people, vehicles, objects, units, structures)
- Action must be physically visible (walking, marching, burning, negotiating, aiming, collapsing, etc.)
- Environment must be real and drawable (city street, battlefield, palace interior, desert convoy route, etc.)
- Camera must imply framing (wide shot, close-up, aerial view, cinematic angle)
- Lighting must be physical (sunset, neon glow, harsh floodlights, foggy dawn, etc.)
- Style must be realistic cinematic unless otherwise implied

========================
VISUAL PRIORITY RULES
========================
- PRIORITIZE what a camera would capture in a single frame
- REMOVE anything that is:
  - political explanation
  - strategic reasoning
  - historical narration
  - invisible systems or concepts
- ONLY keep what can be rendered visually

========================
INPUT
========================
Date: ${action.date}
Title: ${action.title}
Body: ${action.body}
Factions: ${(action.factions || []).join(", ")}

========================
FINAL REQUIREMENT
========================
Return the most visually cinematic single-frame interpretation of the action.
${positiveTags ? `\nIMPORTANT: preserve these exact tags verbatim somewhere in the prompt: ${positiveTags}` : ""}
`;
}

function callOpenRouter(prompt) {
    const cfg = STATE.textAI.openrouter;

    if (!cfg.apiKey) throw new Error("Missing OpenRouter API key");

    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
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
                        content: "You return JSON only."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.4
            }),
            onload: r => {
                try {
                    const data = JSON.parse(r.responseText);
                    resolve(data.choices?.[0]?.message?.content || "");
                } catch (e) {
                    reject(e);
                }
            },
            onerror: reject
        });
    });
}

function callOpenAICompatible(prompt) {
    const cfg = STATE.textAI.openaiCompatible;
    const endpoint = normalizeCompatibleEndpoint(cfg.endpoint);

    return new Promise((resolve, reject) => {
        const headers = {
            "Content-Type": "application/json"
        };

        if (cfg.apiKey) {
            headers.Authorization = `Bearer ${cfg.apiKey}`;
        }

        GM_xmlhttpRequest({
            method: "POST",
            url: endpoint,
            headers,
            data: JSON.stringify({
                model: cfg.model,
                messages: [
                    {
                        role: "system",
                        content: "You return JSON only."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.4
            }),
            onload: r => {
                try {
                    const data = JSON.parse(r.responseText);
                    resolve(data.choices?.[0]?.message?.content || "");
                } catch (e) {
                    reject(e);
                }
            },
            onerror: reject
        });
    });
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
    return (text || "").replace(/```json|```/g, "").trim();
}

function extractJSONObject(text) {
    const cleaned = stripCodeFences(text);
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) return cleaned.slice(first, last + 1);
    return cleaned;
}

async function refineActionWithTextAI(action, hints) {
    if (!STATE.textAI.provider) return action;

    const prompt = buildTextAIPrompt(action, hints);

    try {
        let raw = "";

        if (STATE.textAI.provider === "openrouter") {
            raw = await callOpenRouter(prompt);
        } else if (STATE.textAI.provider === "openai-compatible") {
            raw = await callOpenAICompatible(prompt);
        } else {
            return action;
        }

        const cleaned = extractJSONObject(raw);
        const parsed = JSON.parse(cleaned);

        return {
            ...action,
            title: parsed.title || action.title,
            factions: parsed.factions || action.factions,
            body: parsed.prompt || action.body
        };

    } catch (e) {
        console.warn("Text AI failed, fallback to raw action", e);
        return action;
    }
}

/* =========================
   FLUX PROMPT BUILDER
========================= */
function buildPrompt(action, hints) {
    const visual = compressAction(action.body);

    let factions = action.factions || [];

    const blacklist = new Set(["God", "god", "GOD"]);

    factions = factions
        .filter(f => !blacklist.has(f))
        .slice(0, 4);

    const factionText = factions.length
        ? factions.join(", ") + "."
        : "";

    const title = (action.title || "")
        .replace(/['"]/g, "")
        .slice(0, 120);

    const styleTags = hints?.positivePrompt || "";

    return [
        action.date ? action.date + "." : "",
        factionText,
        title,
        visual,
        styleTags,
        "",
        "cinematic wide shot",
        "realistic environment",
        "high detail",
        "soft natural lighting"
    ]
    .filter(Boolean)
    .join("\n");
}

/* =========================
   WORKFLOW INJECTION
========================= */
function buildWorkflow(action) {
    const base = getWorkflow();
    if (!base) return null;

    const hints = extractWorkflowPromptHints(base);
    const wf = safeClone(base);
    const prompt = buildPrompt(action, hints);

    let targetNode = null;

    for (const [id, node] of Object.entries(wf)) {
        if (!node?.class_type) continue;

        if (node.class_type === "CLIPTextEncode" && node.inputs) {
            const text = node.inputs.text;
            const title = String(node?._meta?.title || "").toLowerCase();

            const isNegative = title.includes("negative");
            const isPositive = title.includes("positive") || !isNegative;

            if (isPositive && typeof text === "string") {
                targetNode = node;
                break;
            }
        }
    }

    if (!targetNode && wf["6"]?.inputs?.text !== undefined) {
        targetNode = wf["6"];
    }

    if (!targetNode) return null;

    targetNode.inputs.text = prompt;

    return wf;
}

function send(wf) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: "POST",
            url: STATE.host + "/prompt",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ prompt: wf }),
            onload: r => resolve(JSON.parse(r.responseText)),
            onerror: reject
        });
    });
}

function pollResult(promptId) {
    return new Promise((resolve, reject) => {
        let tries = 0;

        const t = setInterval(() => {
            tries++;

            GM_xmlhttpRequest({
                method: "GET",
                url: `${STATE.host}/history/${promptId}`,
                onload: r => {
                    try {
                        const data = JSON.parse(r.responseText);
                        const entry = data?.[promptId];

                        if (!entry) return;

                        const status = entry?.status?.status_str;

                        if (status === "error" || status === "canceled") {
                            clearInterval(t);
                            reject("ComfyUI error");
                            return;
                        }

                        const outputs = entry?.outputs;

                        if (outputs) {
                            for (const k in outputs) {
                                const imgs = outputs[k]?.images;
                                if (imgs?.length) {
                                    clearInterval(t);
                                    const img = imgs[0];
                                    resolve(
                                        `${STATE.host}/view?filename=${img.filename}&subfolder=${img.subfolder}&type=${img.type}`
                                    );
                                    return;
                                }
                            }
                        }

                    } catch {}
                }
            });

            if (tries > 60) {
                clearInterval(t);
                reject("timeout");
            }
        }, 2000);
    });
}

function ensurePreview(id) {
    let el = document.querySelector(`[data-ph-img="${id}"]`);
    if (el) return el;

    el = document.createElement("div");
    el.className = PREVIEW_CLASS;
    el.dataset.phImg = id;

    Object.assign(el.style, {
        marginTop: "12px",
        padding: "10px",
        borderRadius: "12px",
        background: "rgba(20,20,20,0.75)",
        color: "#fff",
        fontSize: "12px",
        maxWidth: "420px"
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
    card.appendChild(preview);
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
        save();
        renderFields();
    };

    renderFields();

    container.appendChild(title);
    container.appendChild(providerLabel);
    container.appendChild(provider);
    container.appendChild(fields);
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

    const wfSetActive = document.createElement("button");
    wfSetActive.type = "button";
    wfSetActive.textContent = "Set Active";
    styleButton(wfSetActive, "muted");

    const wfDelete = document.createElement("button");
    wfDelete.type = "button";
    wfDelete.textContent = "Delete Selected";
    styleButton(wfDelete, "danger");

    wfActions.appendChild(wfSetActive);
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
        alignItems: "center"
    });

    const test = document.createElement("button");
    test.type = "button";
    test.textContent = "Test Connection";
    styleButton(test, "muted");

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    styleButton(close);

    bottom.appendChild(test);
    bottom.appendChild(close);

    box.appendChild(header);
    box.appendChild(general);
    box.appendChild(textAISection);
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

    wfSetActive.onclick = () => {
        STATE.activeWorkflow = wfSelect.value || null;
        save();
        renderWorkflowList(wfSelect, wfStatus, wfDelete);
    };

    wfDelete.onclick = () => {
        const name = wfSelect.value;
        if (!name) return;

        try {
            delete STATE.workflows[name];
            if (STATE.activeWorkflow === name) STATE.activeWorkflow = null;
            save();
            renderWorkflowList(wfSelect, wfStatus, wfDelete);
        } catch {}
    };

    test.onclick = () => {
        GM_xmlhttpRequest({
            method: "GET",
            url: STATE.host,
            onload: () => alert("OK"),
            onerror: () => alert("FAIL")
        });
    };

    close.onclick = () => m.remove();
}

async function process() {
    ensureButton();

    const cards = getActions();
    if (!cards.length) return;

    const baseWorkflow = getWorkflow();
    const hints = extractWorkflowPromptHints(baseWorkflow);

    for (const card of cards) {
        const action = extract(card);
        if (!action.body && !action.title) continue;

        const sig = signature(action);
        if (processed.has(sig)) continue;
        processed.add(sig);

        const preview = ensurePreview(sig);
        attachInline(card, preview);
        preview.innerHTML = "Queued...";

        const refined = await refineActionWithTextAI(action, hints);
        const wf = buildWorkflow(refined);
        if (!wf) {
            preview.innerHTML = "Failed to generate image";
            continue;
        }

        send(wf)
            .then(res => {
                return pollResult(res?.prompt_id);
            })
            .then(url => {
                const img = document.createElement("img");
                img.src = url + "&t=" + Date.now();

                Object.assign(img.style, {
                    width: "100%",
                    borderRadius: "10px",
                    cursor: "pointer"
                });

                img.onclick = () => openViewer(img.src);

                preview.innerHTML = "";
                preview.appendChild(img);
            })
            .catch(() => {
                preview.innerHTML = "Failed to generate image";
            });
    }
}

const observer = new MutationObserver(process);
observer.observe(document.body, { childList: true, subtree: true });

process();

})();
