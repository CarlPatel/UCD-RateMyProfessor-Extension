console.log("[UCD-RMP] background service worker loaded");

const RMP_GRAPHQL = "https://www.ratemyprofessors.com/graphql";
const SCHOOL_NAME_DEFAULT = "University of California Davis";

// UC Davis RateMyProfessors school page: https://www.ratemyprofessors.com/school/1073
const UCD_SCHOOL_LEGACY_ID = 1073;


// Simple in-memory cache (service worker lifetime)
let cachedSchoolId = null;

async function gqlRequest(body) {
    const res = await fetch(RMP_GRAPHQL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`RMP GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

async function getSchoolIdByName(_schoolName) {
    const relayId = `School-${UCD_SCHOOL_LEGACY_ID}`;
    return btoa(relayId);
}

function normalize(s) {
    return (s || "")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
}

// Handles compound last names too (e.g., "Sadoghi Hamedani")
function buildLastNameCandidates(last) {
    const cleaned = (last || "")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[.,]/g, "");

    if (!cleaned) return [];
    const parts = cleaned.split(" ").filter(Boolean);

    const out = new Set();
    out.add(cleaned);

    if (parts.length >= 2) {
        out.add(parts[parts.length - 1]);
        out.add(parts[0]);
    }

    return Array.from(out);
}

function pickBestTeacherMatch(edges, prof) {
    // edges: GraphQL edges from teachers search
    // prof: { first, firstInitial, last, display }
    const nodes = (edges || []).map(e => e?.node).filter(Boolean);
    if (!nodes.length) return null;

    const qFirst = normalize(prof.first);
    const qInitial = (prof.firstInitial || "").toUpperCase();
    const qLastCandidates = buildLastNameCandidates(prof.last).map(s => normalize(s));

    let best = null;
    let bestScore = -1;

    for (const t of nodes) {
        const tFirst = (t.firstName || "").trim();
        const tLast = (t.lastName || "").trim();

        const tFirstNorm = normalize(tFirst);
        const tLastNorm = normalize(tLast);

        // must match at least one last-name candidate (exact or contains)
        let lastScore = 0;
        for (const ql of qLastCandidates) {
            if (!ql) continue;
            if (tLastNorm === ql) lastScore = Math.max(lastScore, 50);
            else if (tLastNorm.includes(ql) || ql.includes(tLastNorm)) lastScore = Math.max(lastScore, 35);
        }
        if (lastScore === 0) continue;

        let score = lastScore;

        // first-name exact match if available
        if (qFirst && tFirstNorm === qFirst) score += 20;

        // first initial match if we have it
        if (qInitial && tFirst && tFirst[0].toUpperCase() === qInitial) score += 10;

        // prefer more ratings
        const n = Number(t.numRatings || 0);
        score += Math.min(10, Math.log10(n + 1) * 5);

        if (score > bestScore) {
            bestScore = score;
            best = t;
        }
    }

    return best;
}

async function searchTeacherAtSchool(schoolId, textQuery, profParsed) {
    const query = `
    query TeacherSearch($q: TeacherSearchQuery!, $first: Int) {
      newSearch {
        teachers(query: $q, first: $first) {
          edges {
            node {
              id
              legacyId
              firstName
              lastName
              department
              avgRating
              avgDifficulty
              numRatings
              wouldTakeAgainPercent
              school { id name }

            }
          }
        }
      }
    }
  `;

    const data = await gqlRequest({
        query,
        variables: {
            q: {
                text: textQuery,
                schoolID: schoolId,
                fallback: false
            },
            first: 25
        }
    });

    const edges = data?.data?.newSearch?.teachers?.edges ?? [];
    const best = pickBestTeacherMatch(edges, profParsed);
    if (!best) return null;

    return {
        firstName: best.firstName || "",
        lastName: best.lastName || "",
        avgRating: best.avgRating ?? 0,
        avgDifficulty: best.avgDifficulty ?? null,
        wouldTakeAgainPercent: best.wouldTakeAgainPercent ?? null,
        numRatings: best.numRatings ?? 0,
        department: best.department ?? null,
        legacyId: best.legacyId,
        profileUrl: best.legacyId
            ? `https://www.ratemyprofessors.com/professor/${best.legacyId}`
            : null
    };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type !== "GET_RMP") return;

        const schoolName = msg.schoolName || SCHOOL_NAME_DEFAULT;
        const prof = msg.prof; // {first, firstInitial, last, display, skip}

        if (!prof || prof.skip || !prof.last) {
            sendResponse({ ok: false, error: "Bad professor name" });
            return;
        }

        const schoolId = await getSchoolIdByName(schoolName);
        if (!schoolId) {
            sendResponse({ ok: false, error: "School not found" });
            return;
        }

        // Build a search query string that RMP is likely to match
        const q = prof.last || prof.display || "";

        const result = await searchTeacherAtSchool(schoolId, q, prof);
        if (!result) {
            sendResponse({ ok: false, error: "No teacher match" });
            return;
        }

        sendResponse({
            ok: true,
            rating: Number(result.avgRating) || 0,
            difficulty: result.avgDifficulty,
            wouldTakeAgain: result.wouldTakeAgainPercent,
            numRatings: result.numRatings,
            department: result.department,
            profileUrl: result.profileUrl,
            firstName: result.firstName,
            lastName: result.lastName
        });
    })().catch(err => {
        sendResponse({ ok: false, error: String(err?.message || err) });
    });

    return true; // keeps sendResponse alive for async
});