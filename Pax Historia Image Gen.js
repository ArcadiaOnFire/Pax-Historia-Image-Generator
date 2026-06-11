// ==UserScript==
// @name         Pax Historia Image Gen
// @match        https://paxhistoria.co/*
// @match        https://www.paxhistoria.co/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

const STATE = {
    engine: "ComfyUI",
    host: "http://127.0.0.1:8188",
    activeWorkflow: null,
    workflows: {}
};

const processed = new Set();
const BTN_ID = "ph-img-gen-btn";
const MODAL_ID = "ph-img-modal";
const VIEW_ID = "ph-img-viewer";
const PREVIEW_CLASS = "ph-img-inline";

function save() {
    localStorage.setItem("ph_img_state", JSON.stringify(STATE));
}

function load() {
    try {
        const r = localStorage.getItem("ph_img_state");
        if (r) Object.assign(STATE, JSON.parse(r));
    } catch {}
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
   PROMPT CLEANING (LIGHT TOUCH)
========================= */
function compressAction(body) {
    if (!body) return "";

    let text = body.replace(/\s+/g, " ").trim();
    const sentences = text.split(/(?<=[.!?])\s+/);

    const visual = [];

    for (const s of sentences) {
        const l = s.toLowerCase();

        // ONLY remove non-visual bureaucracy / analysis
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
   FLUX PROMPT BUILDER
========================= */
function buildPrompt(action) {

    const visual = compressAction(action.body);

    return [
        action.date ? action.date + "." : "",
        action.factions?.length ? action.factions.join(", ") + "." : "",
        action.title ? action.title + "." : "",
        visual,

        "",
        "cinematic wide shot",
        "post-apocalyptic wasteland",
        "environmental storytelling",
        "high detail",
        "realistic lighting"
    ]
    .filter(Boolean)
    .join("\n");
}

/* =========================
   WORKFLOW INJECTION (FIXED)
========================= */
function buildWorkflow(action) {
    const base = getWorkflow();
    if (!base) return null;

    const wf = safeClone(base);
    const prompt = buildPrompt(action);

    console.log("=== PH FLUX PROMPT ===");
    console.log(prompt);
    console.log("======================");

    // IMPORTANT FIX: target ONLY the real FLUX prompt node
    if (wf["6"]?.inputs?.text !== undefined) {
        wf["6"].inputs.text = prompt;
    }

    return wf;
}

function send(wf) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: "POST",
            url: STATE.host + "/prompt",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ prompt: wf }),
            onload: r => {
                try {
                    resolve(JSON.parse(r.responseText));
                } catch (e) {
                    reject(e);
                }
            },
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
                        const outputs = entry?.outputs;

                        if (outputs) {
                            for (const k in outputs) {
                                const imgs = outputs[k]?.images;
                                if (imgs?.length) {
                                    clearInterval(t);
                                    const img = imgs[0];
                                    resolve(`${STATE.host}/view?filename=${img.filename}&subfolder=${img.subfolder}&type=${img.type}`);
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

    m.appendChild(img);
    m.onclick = () => m.remove();
    document.body.appendChild(m);
}

function attachInline(card, preview) {
    card.appendChild(preview);
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
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 999999
    });

    const box = document.createElement("div");

    Object.assign(box.style, {
        width: "520px",
        background: "#1e1e1e",
        color: "#fff",
        padding: "16px",
        borderRadius: "12px"
    });

    box.innerHTML = `
        <div style="font-size:16px;margin-bottom:10px;">Image Generation</div>
        <label>Engine</label>
        <select id="engine" style="width:100%;margin-bottom:8px;">
            <option>ComfyUI</option>
            <option>Stable-Diffusion</option>
        </select>
        <label>Host</label>
        <input id="host" style="width:100%;margin-bottom:8px;" value="${STATE.host}" />
        <label>Workflow Upload</label>
        <input type="file" id="wf" style="margin-bottom:10px;" />
        <button id="test" style="width:100%;margin-bottom:10px;">Test Connection</button>
        <div style="display:flex;justify-content:flex-end;">
            <button id="close">Close</button>
        </div>
    `;

    m.appendChild(box);
    document.body.appendChild(m);

    $("#close").onclick = () => m.remove();

    $("#engine").value = STATE.engine;
    $("#engine").onchange = e => {
        STATE.engine = e.target.value;
        save();
        ensureButton();
    };

    $("#host").oninput = e => {
        STATE.host = e.target.value;
        save();
    };

    $("#test").onclick = () => {
        GM_xmlhttpRequest({
            method: "GET",
            url: STATE.host,
            onload: () => alert("ComfyUI reachable"),
            onerror: () => alert("Connection failed")
        });
    };

    $("#wf").onchange = e => {
        const f = e.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
            try {
                STATE.workflows[f.name] = JSON.parse(r.result);
                STATE.activeWorkflow = f.name;
                save();
                alert("Workflow loaded: " + f.name);
            } catch {
                alert("Workflow parse error");
            }
        };
        r.readAsText(f);
    };
}

function process() {
    ensureButton();

    const cards = getActions();
    if (!cards.length) return;

    cards.forEach(card => {
        const action = extract(card);
        if (!action.body && !action.title) return;

        const sig = signature(action);
        if (processed.has(sig)) return;
        processed.add(sig);

        const wf = buildWorkflow(action);
        if (!wf) return;

        const preview = ensurePreview(sig);
        attachInline(card, preview);

        send(wf)
            .then(res => {
                preview.innerHTML = "Queued...";
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
    });
}

const observer = new MutationObserver(process);
observer.observe(document.body, { childList: true, subtree: true });

process();

})();
