const processed = new WeakSet();

// ===== Session cache (prevents re-fetch on scroll / rerender) =====
const rmpCache = new Map();   // key -> resp
const inFlight = new Map();   // key -> Promise

function profKey(parsed) {
    // Stable cache key for the same professor identity.
    // Keep accents as-is since you said "don't normalize accents".
    const display = (parsed.display || "").replace(/\s+/g, " ").trim();
    const last = (parsed.last || "").trim();
    const fi = (parsed.firstInitial || "").trim();
    return `${fi}|${last}|${display}`.toLowerCase();
}

// ---------- Name Parsing Helpers ----------
const SKIP_NAMES = new Set(["the staff", "staff", "tba", "tbd", "instructor"]);

function cleanProfessorDisplayName(raw) {
    return (raw || "")
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim();
}

function parseProfessorName(raw) {
    const name = cleanProfessorDisplayName(raw);
    if (!name) return null;

    const lowered = name.toLowerCase();
    if (SKIP_NAMES.has(lowered)) return { skip: true, display: name };

    if (name.includes(",")) {
        const [lastPart, firstPart] = name.split(",").map(s => s.trim());
        const firstTokens = (firstPart || "").split(" ").filter(Boolean);

        return {
            skip: false,
            display: name,
            first: firstTokens[0] || "",
            firstInitial: (firstTokens[0] || "").slice(0, 1).toUpperCase(),
            last: lastPart || ""
        };
    }

    const tokens = name.split(" ").filter(Boolean);
    const firstTok = tokens[0] || "";
    const maybeInitial = firstTok.replace(".", "");
    const hasInitial = maybeInitial.length === 1 && /[A-Za-z]/.test(maybeInitial);

    if (hasInitial) {
        return {
            skip: false,
            display: name,
            first: "",
            firstInitial: maybeInitial.toUpperCase(),
            last: tokens.slice(1).join(" ")
        };
    }

    if (tokens.length >= 2) {
        return {
            skip: false,
            display: name,
            first: tokens[0],
            firstInitial: tokens[0].slice(0, 1).toUpperCase(),
            last: tokens.slice(1).join(" ")
        };
    }

    return { skip: false, display: name, first: "", firstInitial: "", last: name };
}

// ---------- UI ----------
function makeBadge() {
    const el = document.createElement("span");
    el.className = "rmp-pill";
    el.textContent = "N/A";
    return el;
}

// ---------- Messaging (cached) ----------
function requestRatingCached(parsedProf) {
    const key = profKey(parsedProf);

    // 1) Serve from cache
    if (rmpCache.has(key)) {
        return Promise.resolve(rmpCache.get(key));
    }

    // 2) Deduplicate in-flight requests
    if (inFlight.has(key)) {
        return inFlight.get(key);
    }

    console.log("[UCD-RMP] sending GET_RMP for", parsedProf, "key=", key);

    const p = new Promise((resolve) => {
        // If the extension got reloaded, runtime can be invalid
        if (!chrome?.runtime?.id) {
            const resp = { ok: false, error: "Extension context invalidated" };
            rmpCache.set(key, resp);
            inFlight.delete(key);
            resolve(resp);
            return;
        }

        try {
            chrome.runtime.sendMessage(
                { type: "GET_RMP", schoolName: "University of California Davis", prof: parsedProf },
                (resp) => {
                    const err = chrome.runtime.lastError;
                    const finalResp = err ? { ok: false, error: err.message || String(err) } : resp;

                    rmpCache.set(key, finalResp);
                    inFlight.delete(key);
                    resolve(finalResp);
                }
            );
        } catch (e) {
            const finalResp = { ok: false, error: e?.message || String(e) };
            rmpCache.set(key, finalResp);
            inFlight.delete(key);
            resolve(finalResp);
        }
    });

    inFlight.set(key, p);
    return p;
}

// ---------- Main Logic ----------
async function handleInstructorAnchor(a) {
    if (processed.has(a)) return;
    processed.add(a);

    const parsed = parseProfessorName(a.textContent);
    if (!parsed || parsed.skip) return;

    const key = profKey(parsed);

    const container = a.closest(".results-instructor");
    if (!container) return;

    // If we already injected a badge for THIS professor in this container, skip
    if (container.querySelector(`.rmp-pill[data-rmp-key="${CSS.escape(key)}"]`)) return;

    const badge = makeBadge();
    badge.dataset.rmpKey = key; // mark badge as belonging to this prof
    container.appendChild(badge);

    const resp = await requestRatingCached(parsed);

    // If extension got reloaded mid-flight, don't leave junk badges behind
    if (!resp || !resp.ok) {
        badge.textContent = "N/A";
        badge.classList.add("rmp-pill");

        const searchText = `${parsed.display} Rate My Professor University of California Davis`;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchText)}`;

        // Tooltip (interactive)
        const tooltip = document.createElement("div");
        tooltip.className = "rmp-tooltip";
        tooltip.innerHTML = `
        <div class="rmp-tooltip-name">${parsed.display}</div>
        <div class="rmp-tooltip-notfound">Click to search on Google</div>
    `;

        // Clicking tooltip opens search
        tooltip.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(searchUrl, "_blank");
        };

        badge.appendChild(tooltip);

        // Clicking pill also opens search
        badge.style.cursor = "pointer";
        badge.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(searchUrl, "_blank");
        };

        return;
    }

    const fullName =
        resp.firstName && resp.lastName
            ? `${resp.firstName} ${resp.lastName}`
            : parsed.display;

    const rating =
        (typeof resp.rating === "number")
            ? resp.rating.toFixed(1)
            : "n/a";

    const diff =
        (typeof resp.difficulty === "number")
            ? resp.difficulty.toFixed(1)
            : "n/a";

    const wta =
        (typeof resp.wouldTakeAgain === "number")
            ? `${resp.wouldTakeAgain.toFixed(0)}%`
            : "n/a";

    // Badge text: just rating
    badge.textContent = rating;

    // Tooltip content
    const tooltip = document.createElement("div");
    tooltip.className = "rmp-tooltip";
    tooltip.innerHTML = `
        <div class="rmp-tooltip-name">${fullName}</div>
        <div class="rmp-tooltip-row">
            <span>Rating</span>
            <strong>${rating}</strong>
        </div>
        <div class="rmp-tooltip-row">
            <span>Difficulty</span>
            <strong>${diff}</strong>
        </div>
        <div class="rmp-tooltip-row">
            <span>Would Take Again</span>
            <strong>${wta}</strong>
        </div>
    `;
    badge.appendChild(tooltip);



    // Click to open profile
    if (resp.profileUrl) {
        badge.style.cursor = "pointer";
        badge.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(resp.profileUrl, "_blank");
        };
    }
}

function scan(root = document) {
    const instructors = root.querySelectorAll(".course-details .results-instructor a");
    instructors.forEach(handleInstructorAnchor);
}

// Initial scan
scan();

// Watch for Schedule Builder updates (debounced)
let scanTimer = null;

const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(document), 250);
});

observer.observe(document.documentElement, { childList: true, subtree: true });