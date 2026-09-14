/* Estela Living — Procurement & Release Control
   Static, client-side only: fetches the 4 source systems directly in-browser
   on an interval, joins them, computes release-readiness + reconciliation,
   and persists only OUR OWN state (release checkmarks, reviewed lines) to
   Supabase — never writes back to any source system. */

(function () {
  "use strict";

  // ---- Config ---------------------------------------------------------
  var BUDGET_API = "https://ugen7uxo8f.execute-api.us-east-2.amazonaws.com/prod/housebudget";
  var RELEASE_API = "https://o4txs47a16.execute-api.us-east-2.amazonaws.com/prod/houserelease";
  var WO_API = "https://15ks0h98v5.execute-api.us-east-2.amazonaws.com/prod/workorders";
  var PERMIT_REST = "https://raqiscditxkvgadiostr.supabase.co/rest/v1/permit_database?id=eq.1";

  var SB_URL = "https://raqiscditxkvgadiostr.supabase.co";
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhcWlzY2RpdHhrdmdhZGlvc3RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0ODM1NTMsImV4cCI6MjA5NjA1OTU1M30.5Y2c6kiORxfGN_BLdGk_InwnoYxAqlH55ruuZNzeVKQ";
  var STATE_TABLE = "procurement_flow_state";

  var REFRESH_MS = 45000;
  var CAUTION_THRESHOLD = 200;
  var FLAG_THRESHOLD = 300;
  var LOOKAHEAD_DAYS = 7;

  var STAGE_LABEL = {
    F: "Permit Submitted", L: "Pre Dry-In (7 days)", O: "Pre Drywall (7 days)", Q: "Buyer Assigned"
  };

  // ---- State ------------------------------------------------------------
  var houses = [];       // joined house+permit+release rows
  var reconRows = [];    // joined budget+WO rows
  var localState = { releases: {}, reconReviewed: {} };
  var sb = null;
  var activeView = "queue";
  var activeStage = "ALL";
  var activeReconStatus = "ALL";
  var activeReconStage = "ALL";

  function getSb() {
    if (!sb && window.supabase) sb = window.supabase.createClient(SB_URL, SB_KEY);
    return sb;
  }

  // ---- Helpers ------------------------------------------------------------
  function normAddr(s) {
    if (!s) return "";
    return s.split(",")[0].trim().toUpperCase().replace(/\s+/g, " ");
  }
  function houseKey(companycode, housenumber) { return companycode + "|" + housenumber; }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function daysBetween(a, b) { return Math.round((a - b) / 86400000); }
  function parseDate(s) { return s ? new Date(s + "T00:00:00") : null; }
  function todayLocal() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function fmtMoney(n) { return n == null ? "—" : "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtDate(d) { return d ? d.toISOString().slice(0, 10) : "—"; }
  function isSpec(name) {
    if (!name) return true;
    return name.trim().toUpperCase() === "SPEC";
  }

  // ---- Fetch ------------------------------------------------------------
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.json();
    });
  }
  function fetchPermits() {
    return fetch(PERMIT_REST, {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY }
    }).then(function (r) { return r.json(); }).then(function (rows) {
      return (rows && rows[0] && rows[0].data && rows[0].data.permits) || [];
    });
  }

  function loadState() {
    var client = getSb();
    if (!client) return Promise.resolve();
    return client.from(STATE_TABLE).select("data").eq("id", 1).single().then(function (res) {
      if (res.data && res.data.data) {
        localState = res.data.data;
        localState.releases = localState.releases || {};
        localState.reconReviewed = localState.reconReviewed || {};
      }
    }).catch(function () { /* table may not exist yet, or empty — start fresh */ });
  }
  function saveState() {
    var client = getSb();
    if (!client) return;
    client.from(STATE_TABLE).upsert({ id: 1, data: localState, updated_at: new Date().toISOString() })
      .then(function (res) { if (res.error) console.warn("state save failed:", res.error); });
  }

  // ---- Join + compute ------------------------------------------------------------
  function buildHouses(releaseRows, budgetRows, permits) {
    var byAddr = {};
    releaseRows.forEach(function (h) { byAddr[normAddr(h.address1)] = h; });

    var permitByAddr = {};
    permits.forEach(function (p) { permitByAddr[normAddr(p.address)] = p; });

    return releaseRows.map(function (h) {
      var permit = permitByAddr[normAddr(h.address1)] || null;
      var key = houseKey(h.companycode, h.housenumber);
      return {
        key: key,
        companycode: h.companycode,
        developmentcode: h.developmentcode,
        housenumber: h.housenumber,
        modelcode: h.modelcode,
        elevationcode: h.elevationcode,
        address: h.address1,
        buyername: h.buyername,
        dryinghome: parseDate(h.dryinghome),
        drywall: parseDate(h.drywall),
        cabinets: parseDate(h.cabinets),
        pourslab: parseDate(h.pourslab),
        finalclean: parseDate(h.finalclean),
        permit: permit,
        permitStatus: permit ? permit.permitStatus : null,
        submittedDate: permit && permit.stageDates ? parseDate(permit.stageDates.submitted) : null,
        permitNumber: permit ? permit.permitNumber : null
      };
    });
  }

  function stageStatus(house, stage) {
    var relKey = house.key + "|" + stage;
    var released = localState.releases[relKey];
    if (released) return { state: "released", info: released };

    var today = todayLocal();
    if (stage === "F") {
      if (!house.permit) return { state: "unknown" };
      // Only "applied" (submitted, actively under city review) belongs in the queue.
      // "issued"/"co" means the city has moved past review — already handled, drop it.
      if (house.permitStatus === "issued" || house.permitStatus === "co") return { state: "unknown" };
      var days = house.submittedDate ? daysBetween(today, house.submittedDate) : null;
      return house.permitStatus === "applied"
        ? { state: "due", days: days }
        : { state: "notyet", note: "Not yet submitted (" + (house.permitStatus || "no status") + ")" };
    }
    if (stage === "L" || stage === "O") {
      var target = stage === "L" ? house.dryinghome : house.drywall;
      if (!target) return { state: "unknown" };
      var dueDate = new Date(target); dueDate.setDate(dueDate.getDate() - LOOKAHEAD_DAYS);
      return today >= dueDate
        ? { state: "due", days: daysBetween(today, dueDate) }
        : { state: "notyet", date: target, dueDate: dueDate };
    }
    if (stage === "Q") {
      var hasBuyer = !isSpec(house.buyername);
      if (!hasBuyer) return { state: "notyet", note: "SPEC — no buyer" };
      if (!house.cabinets) return { state: "unknown" };
      return today >= house.cabinets
        ? { state: "due" }
        : { state: "notyet", date: house.cabinets };
    }
    return { state: "unknown" };
  }

  var STAGE_ORDER = ["F", "L", "O", "Q"];

  // A house should only ever have ONE actionable stage at a time: L can't be
  // due until F is actually released, O until L, Q until O. Each stage's own
  // condition (permit status / schedule date) is still evaluated independently
  // above, but here we gate it behind the prior stage actually being released
  // (or not applicable at all, e.g. F once the permit is past our review
  // window) -- otherwise a house that's behind on F would also show L/O/Q as
  // "due" just because their dates happened to pass too.
  function gatedStatuses(house) {
    var result = {};
    var cleared = true;
    STAGE_ORDER.forEach(function (stage, i) {
      var effective = cleared
        ? stageStatus(house, stage)
        : { state: "blocked", waitingOn: STAGE_ORDER[i - 1] };
      result[stage] = effective;
      cleared = (effective.state === "released" || effective.state === "unknown");
    });
    return result;
  }

  function buildRecon(budgetRows, woRows) {
    var byLine = {}; // companycode|housenumber|catcc -> {budget row, wos:[]}
    budgetRows.forEach(function (b) {
      var catcc = b.categorycode + "-" + b.costcode;
      var k = b.companycode + "|" + b.housenumber + "|" + catcc;
      byLine[k] = { budget: b, catcc: catcc, wos: [] };
    });
    woRows.forEach(function (w) {
      var k = w.companycode + "|" + w.housenumber + "|" + w.catcc;
      if (!byLine[k]) byLine[k] = { budget: null, catcc: w.catcc, wos: [] };
      byLine[k].wos.push(w);
    });

    var rows = [];
    Object.keys(byLine).forEach(function (k) {
      var entry = byLine[k];
      if (entry.wos.length === 0) return; // nothing released yet — not a reconciliation candidate
      var woTotal = entry.wos.reduce(function (s, w) { return s + (num(w.amount) || 0); }, 0);
      var budgetAmt = entry.budget ? num(entry.budget.budgetamount) : null;
      var actualAmt = entry.budget ? num(entry.budget.actual) : null;
      var diff = budgetAmt == null ? null : woTotal - budgetAmt;
      var absDiff = diff == null ? null : Math.abs(diff);
      var isDup = entry.wos.length > 1;
      var status;
      if (isDup) status = "DUPLICATE";
      else if (absDiff == null) status = "CAUTION";
      else if (absDiff > FLAG_THRESHOLD) status = "FLAGGED";
      else if (absDiff > CAUTION_THRESHOLD) status = "CAUTION";
      else status = "OK";

      var first = entry.wos[0];
      var parts = k.split("|");
      rows.push({
        key: k,
        companycode: parts[0],
        housenumber: parts[1],
        catcc: entry.catcc,
        developmentcode: (entry.budget && entry.budget.developmentcode) || first.developmentcode,
        desccat: entry.budget ? entry.budget.desccat : "(no budget line)",
        desccost: entry.budget ? entry.budget.desccost : first.description,
        budgetAmt: budgetAmt, actualAmt: actualAmt, woTotal: woTotal,
        woCount: entry.wos.length, wos: entry.wos, diff: diff, status: status
      });
    });
    return rows;
  }

  function attachHouseInfo(recon, houseList) {
    var byKey = {};
    houseList.forEach(function (h) { byKey[h.key] = h; });
    recon.forEach(function (r) {
      var h = byKey[houseKey(r.companycode, r.housenumber)];
      r.address = h ? h.address : null;
      r.modelcode = h ? h.modelcode : null;
    });
  }

  // ---- Data refresh cycle ------------------------------------------------------------
  function setSyncStatus(state, label) {
    var dot = document.getElementById("syncDot");
    dot.className = "dot dot-" + state;
    document.getElementById("syncLabel").textContent = label;
  }

  function refresh() {
    setSyncStatus("pending", "Syncing…");
    Promise.all([fetchJson(RELEASE_API), fetchJson(BUDGET_API), fetchJson(WO_API), fetchPermits()])
      .then(function (results) {
        var releaseRows = results[0], budgetRows = results[1], woRows = results[2], permits = results[3];
        houses = buildHouses(releaseRows, budgetRows, permits);
        reconRows = buildRecon(budgetRows, woRows);
        attachHouseInfo(reconRows, houses);
        populateFilters();
        renderActiveView();
        setSyncStatus("ok", "Live — last synced " + new Date().toLocaleTimeString());
      })
      .catch(function (err) {
        console.error(err);
        setSyncStatus("error", "Sync failed — retrying…");
      });
  }

  // ---- Filters ------------------------------------------------------------
  function currentFilters() {
    return {
      company: document.getElementById("fCompany").value,
      development: document.getElementById("fDevelopment").value,
      model: document.getElementById("fModel").value
    };
  }
  function populateFilters() {
    fillSelect("fCompany", uniq(houses.map(function (h) { return h.companycode; })));
    fillSelect("fDevelopment", uniq(houses.map(function (h) { return h.developmentcode; })));
    fillSelect("fModel", uniq(houses.map(function (h) { return h.modelcode; })));
  }
  function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))).sort(); }
  function fillSelect(id, values) {
    var el = document.getElementById(id);
    var current = el.value;
    el.innerHTML = '<option value="">All</option>' + values.map(function (v) {
      return '<option value="' + v + '">' + v + "</option>";
    }).join("");
    if (values.indexOf(current) >= 0) el.value = current;
  }
  function matchesFilters(companycode, developmentcode, modelcode) {
    var f = currentFilters();
    if (f.company && companycode !== f.company) return false;
    if (f.development && developmentcode !== f.development) return false;
    if (f.model && modelcode && modelcode !== f.model) return false;
    return true;
  }

  // ---- Render: Release Queue ------------------------------------------------------------
  function renderQueue() {
    var showReleased = document.getElementById("showReleased").checked;
    var stages = activeStage === "ALL" ? ["F", "L", "O", "Q"] : [activeStage];
    var byDev = {};

    houses.forEach(function (h) {
      if (!matchesFilters(h.companycode, h.developmentcode, h.modelcode)) return;
      var gated = gatedStatuses(h);
      stages.forEach(function (stage) {
        var st = gated[stage];
        if (st.state === "unknown") return;
        if (st.state === "released" && !showReleased) return;
        var devKey = h.companycode + " / " + h.developmentcode;
        (byDev[devKey] = byDev[devKey] || []).push({ house: h, stage: stage, st: st });
      });
    });

    var groups = Object.keys(byDev).sort();
    if (groups.length === 0) { document.getElementById("queueBody").innerHTML = "<p class='small-muted'>No houses match the current filters/stage.</p>"; return; }

    var html = groups.map(function (g) {
      var items = byDev[g].sort(function (a, b) {
        var order = { due: 0, notyet: 1, blocked: 2, released: 3 };
        return (order[a.st.state] - order[b.st.state]) || a.house.housenumber.localeCompare(b.house.housenumber);
      });
      return '<div class="group-header">' + g + " — " + items.length + " item(s)</div>" +
        items.map(renderQueueRow).join("");
    }).join("");
    document.getElementById("queueBody").innerHTML = html;

    document.querySelectorAll("[data-mark-release]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var relKey = btn.getAttribute("data-mark-release");
        localState.releases[relKey] = { released_at: new Date().toISOString(), by: "manual" };
        saveState();
        renderQueue();
      });
    });
    document.querySelectorAll("[data-unmark-release]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var relKey = btn.getAttribute("data-unmark-release");
        delete localState.releases[relKey];
        saveState();
        renderQueue();
      });
    });
    document.querySelectorAll("[data-review-wos]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var parts = btn.getAttribute("data-review-wos").split("|");
        goToReconFor(parts[0], parts[1]);
      });
    });
  }

  function goToReconFor(housenumber, stage) {
    activeView = "recon";
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-view") === "recon"); });
    ["Queue", "Recon", "House"].forEach(function (v) {
      document.getElementById("view" + v).style.display = (v === "Recon") ? "" : "none";
    });
    document.getElementById("reconHouseSearch").value = housenumber;
    activeReconStage = stage;
    document.querySelectorAll("#reconStageFilter .stage-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-recon-stage") === stage);
    });
    activeReconStatus = "ALL";
    document.querySelectorAll("#reconStatusFilter .stage-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-status") === "ALL");
    });
    renderRecon();
  }

  function renderQueueRow(item) {
    var h = item.house, stage = item.stage, st = item.st;
    var relKey = h.key + "|" + stage;
    var badge, extra = "";
    var reviewBtn = '<button class="mark-btn" data-review-wos="' + h.housenumber + "|" + stage + '">Review released WOs</button>';
    if (st.state === "released") {
      badge = '<span class="badge badge-released">Released ' + st.info.released_at.slice(0, 10) + "</span>";
      extra = '<button class="mark-btn" data-unmark-release="' + relKey + '">Undo</button> ' + reviewBtn;
    } else if (st.state === "due") {
      badge = '<span class="badge badge-due">Due now</span>';
      if (st.days != null) extra = '<span class="days-badge">' + (st.days >= 0 ? st.days + "d since submitted" : "") + "</span>";
      extra += '<button class="mark-btn" data-mark-release="' + relKey + '">Mark released</button> ' + reviewBtn;
    } else if (st.state === "blocked") {
      badge = '<span class="badge badge-notyet">Waiting on Stage ' + st.waitingOn + "</span>";
    } else {
      var when = st.date ? fmtDate(st.date) : (st.note || "not yet due");
      badge = '<span class="badge badge-notyet">' + when + "</span>";
    }
    return '<div class="stage-row"><b>' + stage + "</b> — " + STAGE_LABEL[stage] + " · " +
      h.companycode + "/" + h.developmentcode + "/" + h.housenumber + " · " + (h.address || "") +
      (h.buyername ? " · " + h.buyername : "") + " " + badge + " " + extra + "</div>";
  }

  // ---- Render: Reconciliation ------------------------------------------------------------
  function renderRecon() {
    var showReviewed = document.getElementById("showReviewed").checked;
    var q = (document.getElementById("reconHouseSearch").value || "").trim().toUpperCase();
    var rows = reconRows.filter(function (r) {
      if (!matchesFilters(r.companycode, r.developmentcode, r.modelcode)) return false;
      if (activeReconStatus !== "ALL" && r.status !== activeReconStatus) return false;
      if (activeReconStage !== "ALL" && !r.wos.some(function (w) { return w.stagecode === activeReconStage; })) return false;
      var reviewed = localState.reconReviewed[r.key];
      if (reviewed && !showReviewed) return false;
      if (q && r.housenumber.indexOf(q) < 0 && (r.address || "").toUpperCase().indexOf(q) < 0) return false;
      return true;
    });
    if (rows.length === 0) { document.getElementById("reconBody").innerHTML = "<p class='small-muted'>No lines match.</p>"; return; }

    var byHouse = {};
    rows.forEach(function (r) {
      var hk = houseKey(r.companycode, r.housenumber);
      (byHouse[hk] = byHouse[hk] || []).push(r);
    });
    var houseKeys = Object.keys(byHouse).sort();

    var html = houseKeys.map(function (hk) {
      var lines = byHouse[hk].sort(function (a, b) {
        var order = { DUPLICATE: 0, FLAGGED: 1, CAUTION: 2, OK: 3 };
        return (order[a.status] - order[b.status]) || a.catcc.localeCompare(b.catcc);
      });
      var dupCount = lines.filter(function (l) { return l.status === "DUPLICATE"; }).length;
      var first = lines[0];
      var header = first.companycode + "/" + first.developmentcode + "/" + first.housenumber +
        (first.address ? " — " + first.address : "") +
        (dupCount ? ' <span class="badge badge-dup">' + dupCount + " duplicate cost code(s)</span>" : "");
      return '<div class="group-header">' + header + "</div>" +
        '<table><thead><tr><th>Cost Code</th><th>Description</th><th>Budget</th><th>Actual</th><th>WO Total</th><th>WO Count</th><th>Diff</th><th>Status</th><th></th></tr></thead><tbody>' +
        lines.map(renderReconRow).join("") + "</tbody></table>";
    }).join("");
    document.getElementById("reconBody").innerHTML = html;

    document.querySelectorAll("[data-review]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-review");
        localState.reconReviewed[key] = { reviewed_at: new Date().toISOString() };
        saveState();
        renderRecon();
      });
    });
    document.querySelectorAll("[data-unreview]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-unreview");
        delete localState.reconReviewed[key];
        saveState();
        renderRecon();
      });
    });
  }

  function renderReconRow(r) {
    var badgeClass = { OK: "badge-ok", CAUTION: "badge-caution", FLAGGED: "badge-flag", DUPLICATE: "badge-dup" }[r.status];
    var diffClass = r.diff > 0 ? "diff-pos" : r.diff < 0 ? "diff-neg" : "";
    var reviewed = localState.reconReviewed[r.key];
    var woList = r.wos.map(function (w) { return w.workordernumber + " (" + w.vendorname + ", " + fmtMoney(num(w.amount)) + ", " + w.wodate + (w.stagecode ? ", stage " + w.stagecode : "") + ")"; }).join("<br>");
    return "<tr><td>" + r.catcc + "</td>" +
      "<td>" + r.desccat + (r.desccost ? " — " + r.desccost : "") + "</td>" +
      "<td>" + fmtMoney(r.budgetAmt) + "</td>" +
      "<td>" + fmtMoney(r.actualAmt) + "</td>" +
      "<td>" + fmtMoney(r.woTotal) + "<div class='small-muted'>" + woList + "</div></td>" +
      "<td>" + r.woCount + "</td>" +
      "<td class='" + diffClass + "'>" + (r.diff == null ? "—" : fmtMoney(r.diff)) + "</td>" +
      '<td><span class="badge ' + badgeClass + '">' + r.status + "</span></td>" +
      "<td>" + (reviewed
        ? '<button class="mark-btn" data-unreview="' + r.key + '">Unreview</button>'
        : '<button class="mark-btn" data-review="' + r.key + '">Mark reviewed</button>') + "</td></tr>";
  }

  // ---- Render: House lookup ------------------------------------------------------------
  function renderHouseSearch() {
    var q = (document.getElementById("houseSearch").value || "").trim().toUpperCase();
    if (!q) { document.getElementById("houseBody").innerHTML = ""; return; }
    var matches = houses.filter(function (h) {
      return h.housenumber.indexOf(q) >= 0 || (h.address || "").toUpperCase().indexOf(q) >= 0;
    }).slice(0, 20);
    document.getElementById("houseBody").innerHTML = matches.map(function (h) {
      var lines = reconRows.filter(function (r) { return r.companycode === h.companycode && r.housenumber === h.housenumber; });
      var gated = gatedStatuses(h);
      var stagesHtml = STAGE_ORDER.map(function (s) {
        var st = gated[s];
        var detail = st.date ? " (" + fmtDate(st.date) + ")" : st.waitingOn ? " (waiting on " + st.waitingOn + ")" : "";
        return "<div><b>" + s + "</b>: " + st.state + detail + "</div>";
      }).join("");
      return '<div class="house-card"><h3>' + h.housenumber + " — " + (h.address || "") + '</h3>' +
        '<div class="house-meta">' + h.companycode + "/" + h.developmentcode + " · " + (h.modelcode || "") + " " + (h.elevationcode || "") +
        " · Buyer: " + (h.buyername || "—") + " · Permit#: " + (h.permitNumber || "—") + " (" + (h.permitStatus || "—") + ")</div>" +
        stagesHtml +
        "<div class='small-muted' style='margin-top:8px'>" + lines.length + " reconciliation line(s) with released WOs</div>" +
        "</div>";
    }).join("");
  }

  // ---- View switching ------------------------------------------------------------
  function renderActiveView() {
    if (activeView === "queue") renderQueue();
    else if (activeView === "recon") renderRecon();
    else renderHouseSearch();
  }

  function wireUi() {
    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeView = btn.getAttribute("data-view");
        ["Queue", "Recon", "House"].forEach(function (v) {
          document.getElementById("view" + v).style.display = (v.toLowerCase() === activeView) ? "" : "none";
        });
        renderActiveView();
      });
    });
    document.querySelectorAll("#stageFilter .stage-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#stageFilter .stage-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeStage = btn.getAttribute("data-stage");
        renderQueue();
      });
    });
    document.querySelectorAll("#reconStatusFilter .stage-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#reconStatusFilter .stage-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeReconStatus = btn.getAttribute("data-status");
        renderRecon();
      });
    });
    document.querySelectorAll("#reconStageFilter .stage-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#reconStageFilter .stage-btn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeReconStage = btn.getAttribute("data-recon-stage");
        renderRecon();
      });
    });
    ["fCompany", "fDevelopment", "fModel"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", renderActiveView);
    });
    document.getElementById("showReleased").addEventListener("change", renderQueue);
    document.getElementById("showReviewed").addEventListener("change", renderRecon);
    document.getElementById("reconHouseSearch").addEventListener("input", renderRecon);
    document.getElementById("houseSearch").addEventListener("input", renderHouseSearch);
    document.getElementById("refreshBtn").addEventListener("click", refresh);
  }

  // ---- Boot ------------------------------------------------------------
  wireUi();
  loadState().then(refresh);
  setInterval(refresh, REFRESH_MS);
})();
