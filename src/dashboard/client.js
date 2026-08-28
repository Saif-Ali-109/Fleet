(() => {
	const ROLES = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];
	const TERMINAL_PHASES = ["done", "failed", "aborted"];
	let dash = null,
		log = [],
		es = null,
		pollT = null;
	var configuredModels = {};
	var envModels = {};
	var FOLLOW_RELEASE_PX = 40;
	var FOLLOW_RESTICK_PX = 8;
	var followMap = new Map();
	function computeNextStick(stick, scrollTop, scrollHeight, clientHeight) {
		var fromBottom = scrollHeight - scrollTop - clientHeight;
		if (fromBottom <= FOLLOW_RESTICK_PX) return true;
		if (fromBottom > FOLLOW_RELEASE_PX) return false;
		return stick;
	}
	function setStick(el, val) {
		var st = followMap.get(el);
		if (!st || st.stick === val) return;
		st.stick = val;
		if (st.pill) st.pill.hidden = val;
		if (val) el.scrollTop = el.scrollHeight;
	}
	function followPill(el, st) {
		let pill = st.pill;
		if (!pill) {
			pill = document.createElement("button");
			pill.type = "button";
			pill.className = "follow-pill";
			pill.textContent = "▼ follow";
			pill.hidden = true;
			pill.addEventListener("click", () => {
				setStick(el, true);
			});
			st.pill = pill;
		}
		return pill;
	}
	function followInstall(el) {
		if (!el || followMap.has(el)) return;
		var st = { stick: true, pill: null, glowT: null, raf: 0 };
		followMap.set(el, st);
		el.appendChild(followPill(el, st));
		el.addEventListener("scroll", () => {
			var cur = followMap.get(el);
			if (!cur) return;
			setStick(
				el,
				computeNextStick(
					cur.stick,
					el.scrollTop,
					el.scrollHeight,
					el.clientHeight,
				),
			);
		});
		el.addEventListener(
			"wheel",
			(e) => {
				var cur = followMap.get(el);
				if (cur?.stick && e.deltaY < 0) setStick(el, false);
			},
			{ passive: true },
		);
	}
	function followGlow(el, st) {
		el.classList.add("edge-glow");
		if (st.glowT) clearTimeout(st.glowT);
		st.glowT = setTimeout(() => {
			el.classList.remove("edge-glow");
		}, 600);
	}
	function followAppend(el) {
		var st = followMap.get(el);
		if (!st) return;
		el.appendChild(followPill(el, st));
		if (st.stick) {
			if (!st.raf) {
				st.raf = requestAnimationFrame(() => {
					st.raf = 0;
					el.scrollTop = el.scrollHeight;
				});
			}
		} else {
			followGlow(el, st);
		}
	}
	function installFollowScroll() {
		const ids = ["log", "toolsstream", "railwrap"];
		for (let fi = 0; fi < ids.length; fi++)
			followInstall(document.getElementById(ids[fi]));
		const panels = document.querySelectorAll(".tab-content");
		for (let fj = 0; fj < panels.length; fj++) followInstall(panels[fj]);
	}
	var connEl = null,
		logEl = null,
		metaEl = null;
	var noticeEl = null,
		runActive = false;
	var scantimerEl = null,
		nextScanAt = null;
	function renderScanTimer() {
		if (!scantimerEl) return;
		if (!nextScanAt) {
			scantimerEl.textContent = "";
			return;
		}
		var ms = nextScanAt - Date.now();
		if (ms <= 0) {
			scantimerEl.textContent = "⏳ Next scan due…";
			return;
		}
		var totalSec = Math.floor(ms / 1000);
		var m = Math.floor(totalSec / 60),
			s = totalSec % 60;
		scantimerEl.textContent = `⏳ Next scan in ${m}:${s < 10 ? "0" : ""}${s}`;
	}
	setInterval(renderScanTimer, 1000);
	var stopRequested = false;
	var queueMode = false,
		modelsLoaded = false;
	var provider = "gemini",
		providers = ["gemini", "openrouter", "ollama"];
	var agentEvents = {};
	var _eventSummary = {};
	var errorLog = [],
		logSeeded = false,
		agentEventsSeeded = false;
	var reconnectT = null,
		sseRetries = 0,
		modelsRetryT = null;
	var curTab = "transcript";
	function $(id) {
		return document.getElementById(id);
	}
	function esc(s) {
		return String(s == null ? "" : s).replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[c],
		);
	}
	function fmtErr(v) {
		if (typeof v === "string") return v;
		try {
			return JSON.stringify(v) || String(v);
		} catch (_) {
			return String(v);
		}
	}
	function setConn(live, label) {
		connEl.className = `conn ${live ? "live" : "dead"}`;
		connEl.textContent = label;
	}
	function renderGh(info) {
		var chip = $("gh"),
			banner = $("ghbanner"),
			err = $("gherr"),
			codeDiv = $("ghcode");
		if (!info) return;
		if (info.ok) {
			chip.textContent = `gh: ${info.username}`;
			chip.className = "gh ok";
			banner.hidden = true;
			banner.style.display = "none";
			if (err) err.textContent = "";
			if (codeDiv) codeDiv.hidden = true;
		} else {
			chip.textContent = "gh: signed out";
			chip.className = "gh missing";
			banner.hidden = false;
			banner.style.display = "";
			if (err)
				err.textContent = info.error
					? info.error
					: "Run gh auth login in a terminal, then press Recheck.";
			if (codeDiv) codeDiv.hidden = true;
		}
	}
	function fetchGh() {
		fetch("/api/gh")
			.then((r) => r.json())
			.then((info) => {
				renderGh(info);
			})
			.catch(() => {});
	}
	function renderNotice(n) {
		if (!noticeEl) return;
		noticeEl.textContent = n || "";
		var b = $("startbtn"),
			i = $("repoinput");
		if (b) b.disabled = runActive;
		if (i) i.disabled = runActive;
		if (b) b.textContent = runActive ? "Running…" : "Start";
	}
	function renderStop() {
		var b = $("stopbtn");
		if (!b) return;
		if (runActive || stopRequested) {
			b.textContent = stopRequested ? "Stopping…" : "Stop";
			b.disabled = stopRequested;
		} else {
			b.textContent = "Stop";
			b.disabled = true;
		}
	}
	function requestStop() {
		if (stopRequested) return;
		var resolving = false;
		if (dash?.agents) {
			ROLES.forEach((r) => {
				if (dash.agents[r] && dash.agents[r].state === "running")
					resolving = true;
			});
		}
		var msg = resolving
			? "⚠ An issue is currently being resolved. Do you really want to stop now?"
			: "Do you want to stop?";
		if (!confirm(msg)) return;
		stopRequested = true;
		renderStop();
		fetch("/api/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		})
			.then((r) => r.json())
			.then((d) => {
				if (!d?.ok) renderNotice(d?.error || "stop failed");
			})
			.catch(() => {
				renderNotice("stop failed — network error");
			});
	}
	function renderProvider() {
		const btns = document.querySelectorAll(".provider-btn");
		for (let k = 0; k < btns.length; k++) {
			const active = btns[k].getAttribute("data-provider") === provider;
			btns[k].style.borderColor = active ? "var(--accent)" : "var(--border)";
			btns[k].style.color = active ? "var(--accent)" : "var(--text)";
			btns[k].disabled = runActive;
		}
	}
	function postProvider(p) {
		provider = p;
		renderProvider();
		fetch("/api/provider", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider: p }),
		})
			.then((r) => r.json())
			.then(() => {
				fetchModels();
			})
			.catch(() => {});
	}
	function copyText(text, btn) {
		function fallback() {
			var ta = document.createElement("textarea");
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			try {
				document.execCommand("copy");
			} catch (_e) {}
			document.body.removeChild(ta);
		}
		function flash() {
			if (!btn) return;
			var label = btn.textContent;
			btn.textContent = "Copied";
			setTimeout(() => {
				btn.textContent = label;
			}, 1500);
		}
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(text).then(flash, () => {
				fallback();
				flash();
			});
		} else {
			fallback();
			flash();
		}
	}
	function startLogin() {
		var banner = $("ghbanner"),
			err = $("gherr");
		err.textContent = "Starting login…";
		$("ghlogin").disabled = true;
		fetch("/api/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		})
			.then((r) => r.json())
			.then((d) => {
				$("ghlogin").disabled = false;
				if (!d.ok) {
					err.textContent = d.error || "login failed";
					return;
				}
				if (d.status === "done") {
					err.textContent = "";
					$("ghcode").hidden = true;
					banner.hidden = true;
					$("gh").textContent = `gh: ${d.username || "signed in"}`;
					$("gh").className = "gh ok";
					return;
				}
				$("ghcode").hidden = false;
				$("ghuserCode").textContent = d.userCode;
				if (d.verificationUri) $("ghcodeuri").href = d.verificationUri;
				err.textContent = "Waiting for you to authorize on the device page…";
			})
			.catch(() => {
				$("ghlogin").disabled = false;
				err.textContent = "login failed — network error";
			});
	}
	function fmtCost(c) {
		const n = Number(c);
		return c == null || !Number.isFinite(n) ? "" : `$${n.toFixed(4)}`;
	}
	function n(v) {
		return Number(v || 0).toLocaleString();
	}
	function fmtTokens(t) {
		if (!t) return "";
		const parts = [];
		if (t.input) parts.push(`in:${t.input.toLocaleString()}`);
		if (t.output) parts.push(`out:${t.output.toLocaleString()}`);
		if (t.reasoning) parts.push(`r:${t.reasoning.toLocaleString()}`);
		if (t.cached) parts.push(`cached:${t.cached.toLocaleString()}`);
		if (t.cacheWrite) parts.push(`cacheW:${t.cacheWrite.toLocaleString()}`);
		if (t.total) parts.push(`total:${t.total.toLocaleString()}`);
		return parts.length ? `${parts.join(" ")} tok` : "";
	}
	function fmtCalls(c) {
		if (!c) return "";
		const parts = [];
		if (c.tools) parts.push(`⚙${c.tools}`);
		if (c.models) parts.push(`🤖${c.models}`);
		if (c.skills) parts.push(`📚${c.skills}`);
		return parts.join(" ");
	}
	window.switchTab = (name, btn) => {
		curTab = name;
		const tabs = document.querySelectorAll(".tab-btn");
		for (let i = 0; i < tabs.length; i++) tabs[i].classList.remove("active");
		btn.classList.add("active");
		const contents = document.querySelectorAll(".tab-content");
		for (let j = 0; j < contents.length; j++)
			contents[j].classList.remove("active");
		$(`${name}-tab`).classList.add("active");
		if (name === "memory") fetchMemory();
		if (name === "sessionlog") fetchSessionLog();
		if (name === "errorlog") fetchErrorLog();
	};
	function fetchMemory() {
		var el = $("memory-content");
		if (!el) return;
		el.textContent = "Loading…";
		fetch("/api/memory")
			.then((r) => r.json())
			.then((d) => {
				el.textContent = d.content || "";
			})
			.catch(() => {
				el.textContent = "Error loading MEMORY.txt";
			});
	}
	function fetchSessionLog() {
		var el = $("sessionlog-content");
		if (!el) return;
		el.textContent = "Loading…";
		fetch("/api/session-log")
			.then((r) => r.json())
			.then((d) => {
				el.textContent = d.content || "";
			})
			.catch(() => {
				el.textContent = "Error loading SESSION_LOG.txt";
			});
	}
	function renderErrorLog() {
		const box = $("errorlog-content"),
			empty = $("errorlog-empty");
		if (!box) return;
		if (empty) empty.hidden = errorLog.length > 0;
		box.innerHTML = "";
		if (!errorLog.length) {
			const none = document.createElement("div");
			none.className = "empty";
			none.style.padding = "20px";
			none.style.textAlign = "center";
			none.textContent = "No model limit errors.";
			box.appendChild(none);
			return;
		}
		errorLog.forEach((err) => {
			const div = document.createElement("div");
			div.style =
				"margin-bottom: 8px; padding: 4px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px;";
			const strong = document.createElement("strong");
			strong.textContent = `[${err.type || "error"}] `;
			div.appendChild(strong);
			const span = document.createElement("span");
			span.textContent = err.message;
			div.appendChild(span);
			if (err.issue !== undefined) {
				const issueSpan = document.createElement("span");
				issueSpan.textContent = ` Issue #${err.issue}`;
				div.appendChild(issueSpan);
			}
			const timeSpan = document.createElement("span");
			timeSpan.style = "color: var(--muted); font-size: 11px;";
			timeSpan.textContent = ` @ ${new Date(err.timestamp).toLocaleTimeString()}`;
			div.appendChild(timeSpan);
			box.appendChild(div);
		});
	}
	function fetchErrorLog() {
		if (curTab !== "errorlog") return;
		if (errorLog.length) {
			renderErrorLog();
			return;
		}
		fetch("/api/model-limit-error")
			.then((r) => r.json())
			.then((d) => {
				if (d && Array.isArray(d.errorLog)) errorLog = d.errorLog;
				renderErrorLog();
			})
			.catch(() => {
				renderErrorLog();
			});
	}
	function setModelSelectsDisabled(disabled) {
		ROLES.forEach((r) => {
			const sel = $(`model-${r}`);
			if (sel) sel.disabled = disabled;
		});
	}
	function renderModels(data) {
		var box = $("modelpickers");
		if (!box) return;
		var available = data.available || [];
		var models = data.models || {};
		configuredModels = models;
		envModels = data.envModels || {};
		var html =
			'<div style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center">';
		ROLES.forEach((r) => {
			const current = models[r] || "";
			let opts = "";
			available.forEach((m) => {
				const sel = current === m ? " selected" : "";
				opts += `<option value="${esc(m)}"${sel}>${esc(m)}</option>`;
			});
			const listId = `models-${provider}`;
			html +=
				`<span style="white-space:nowrap;font-size:12px>` +
				`<span class="role" style="margin-right:3px">${esc(r)}` +
				`:</span>` +
				`<input list="${listId}" id="model-${r}" data-role="${r}" value="${esc(current)}" ` +
				`style="width:140px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 5px;font:inherit;font-size:12px">` +
				`<datalist id="${listId}">` +
				opts +
				`</datalist></span>`;
		});
		box.innerHTML = `${html}</div>`;
		setModelSelectsDisabled(runActive);
		renderAgents();
		ROLES.forEach((r) => {
			const inp = $(`model-${r}`);
			if (!inp) return;
			inp.addEventListener("change", () => {
				postModel(inp.getAttribute("data-role"), inp.value);
			});
		});
	}
	function postModel(role, model) {
		var msg = $("modelsmsg");
		if (msg) msg.textContent = "Saving…";
		fetch("/api/models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role: role, model: model, provider: provider }),
		})
			.then((r) => {
				if (r.status === 409)
					return {
						ok: false,
						error: "a run is in progress; cannot change models",
					};
				return r.json();
			})
			.then((d) => {
				fetchModels();
				if (msg) {
					msg.textContent = d?.ok ? "Saved" : d?.error || "update failed";
					if (d?.ok)
						setTimeout(() => {
							msg.textContent = "";
						}, 1500);
				}
			})
			.catch(() => {
				fetchModels();
				if (msg) msg.textContent = "update failed — network error";
			});
	}
	function fetchModels() {
		fetch(`/api/models?provider=${encodeURIComponent(provider)}`)
			.then((r) => r.json())
			.then((d) => {
				if (modelsRetryT) {
					clearTimeout(modelsRetryT);
					modelsRetryT = null;
				}
				renderModels(d);
			})
			.catch(() => {
				if (modelsRetryT) {
					clearTimeout(modelsRetryT);
					modelsRetryT = null;
				}
				modelsRetryT = setTimeout(fetchModels, 2000);
			});
	}
	function syncModelsPanel() {
		if (!modelsLoaded) {
			modelsLoaded = true;
			fetchModels();
		}
		setModelSelectsDisabled(runActive);
		renderProvider();
	}
	function syncStartPanel() {
		var sp = $("startpanel");
		if (sp) sp.hidden = !queueMode;
	}
	function renderMeta() {
		if (!dash) {
			metaEl.textContent =
				"phase not started · waiting for GitHub auth / run start";
			return;
		}
		metaEl.textContent =
			"run " +
			dash.runId +
			" · " +
			dash.repo +
			"#" +
			dash.issue +
			" · phase " +
			dash.phase +
			" · loop " +
			dash.loopIteration;
	}
	function card(a) {
		var icon =
			a.state === "done"
				? "✓"
				: a.state === "failed"
					? "✗"
					: a.state === "running"
						? ""
						: "·";
		var html =
			'<div class="card"><div class="row">' +
			'<span class="badge ' +
			a.state +
			'">' +
			icon +
			"</span>";
		if (a.state === "running") html += '<span class="spinner"></span>';
		var displayName =
			a.model || envModels[a.role] || configuredModels[a.role] || "";
		html +=
			`<span class="role">${esc(a.role)}</span>` +
			`<span class="model">${esc(String(displayName).split("/").pop())}</span></div>`;
		const meta = [];
		const calls = fmtCalls(a.calls);
		if (calls) meta.push(calls);
		if (a.state === "done" && a.costUsd != null) meta.push(fmtCost(a.costUsd));
		if (a.state === "done" && a.tokens != null) meta.push(fmtTokens(a.tokens));
		if (meta.length)
			html += `<div class="meta-line">${esc(meta.join(" · "))}</div>`;
		if (a.error) html += `<div class="err">${esc(fmtErr(a.error))}</div>`;
		return `${html}</div>`;
	}
	function renderAgents() {
		const box = $("agents");
		if (!dash) {
			let html = "";
			ROLES.forEach((r) => {
				const name = envModels[r] || configuredModels[r] || "";
				html +=
					`<div class="card"><div class="row">` +
					`<span class="badge pending">·</span>` +
					`<span class="role">${esc(r)}</span>` +
					`<span class="model">${esc(String(name).split("/").pop())}</span></div></div>`;
			});
			box.innerHTML = html;
			return;
		}
		let html = "";
		if (dash.prUrl && TERMINAL_PHASES.indexOf(dash.phase) !== -1) {
			html += `<div class="meta-line">Run complete — PR: ${esc(dash.prUrl)}</div>`;
		}
		if (dash.totals && (dash.totals.tools || dash.totals.models)) {
			html +=
				`<div class="totals-strip">` +
				`SESSION TOTAL — ⚙${n(dash.totals.tools)}` +
				` tool · 🤖${n(dash.totals.models)}` +
				` model calls · 📚${n(dash.totals.skills)}` +
				` skills · ${fmtCost(dash.totals.costUsd)} · ${n(dash.totals.tokens)} tok</div>`;
		}
		ROLES.forEach((r) => {
			html += card(dash.agents[r]);
		});
		box.innerHTML = html;
	}
	function renderCallStats() {
		var box = $("callstats");
		if (!box || !dash) return;
		var hasAny = false;
		ROLES.forEach((r) => {
			var c = dash.agents[r].calls;
			if (c && (c.tools || c.models || c.skills)) hasAny = true;
		});
		if (
			!hasAny &&
			(!dash.totals ||
				(!dash.totals.tools && !dash.totals.models && !dash.totals.skills))
		) {
			box.innerHTML = '<div class="empty">no calls yet…</div>';
			return;
		}
		let html = `<table><tr><th>role</th><th>\u2699 tools</th><th>\ud83e\udd16 models</th><th>\ud83d\udcda skills</th></tr>`;
		ROLES.forEach((r) => {
			const a = dash.agents[r];
			const c = a.calls;
			html +=
				`<tr><td>${esc(a.role)}</td>` +
				`<td>${c ? c.tools : 0}</td>` +
				`<td>${c ? c.models : 0}</td>` +
				`<td>${c ? c.skills : 0}</td></tr>`;
		});
		if (dash.totals) {
			const t = dash.totals;
			html += `<tr class="footer"><td>TOTAL</td><td>${t.tools}</td><td>${t.models}</td><td>${t.skills}</td></tr>`;
			const meta = [];
			if (t.costUsd) meta.push(fmtCost(t.costUsd));
			if (t.tokens) meta.push(`${t.tokens.toLocaleString()} tok`);
			if (meta.length)
				html += `<tr class="footer"><td colspan="4"><span class="totals-meta">${esc(meta.join(" \u00b7 "))}</span></td></tr>`;
		}
		html += "</table>";
		box.innerHTML = html;
	}
	function logLineHtml(L) {
		return `<div class="line"><span class="lrole l-${L.r}">${esc(L.r)}</span><span>${esc(L.t)}</span></div>`;
	}
	// Full rebuild — used only when (re)seeding the whole transcript from a
	// snapshot/resync. Live single-line arrivals go through appendLogLine
	// instead, so the pane no longer regenerates innerHTML for the entire
	// 200-line buffer on every SSE "output" event.
	function renderLog() {
		if (!log.length) {
			logEl.innerHTML = '<div class="empty">waiting for agent output…</div>';
			return;
		}
		var html = "";
		log.forEach((L) => {
			html += logLineHtml(L);
		});
		logEl.innerHTML = html;
		followAppend(logEl);
		renderAgentEvents();
	}
	function appendLogLine(L) {
		var placeholder = logEl.querySelector(".empty");
		if (placeholder) logEl.innerHTML = "";
		logEl.insertAdjacentHTML("beforeend", logLineHtml(L));
		while (logEl.children.length > 200)
			logEl.removeChild(logEl.firstElementChild);
		followAppend(logEl);
	}
	function pushText(role, text) {
		String(text)
			.split(String.fromCharCode(10))
			.forEach((t) => {
				if (t === "") return;
				var L = { r: role, t: t };
				log.push(L);
				if (log.length > 200) log.shift();
				appendLogLine(L);
			});
	}
	var roleGroupEls = {}; // role -> DOM element holding that role's rendered event items
	function pushAgentEvent(role, ev) {
		if (!agentEvents[role]) agentEvents[role] = [];
		agentEvents[role].push(ev);
		if (agentEvents[role].length > 100) agentEvents[role].shift();
		appendAgentEvent(role, ev);
	}
	// Full rebuild — used only when (re)seeding agentEvents from a
	// snapshot/resync. Live events go through appendAgentEvent instead, which
	// appends a single formatted event into its role's group rather than
	// regenerating innerHTML for every role's entire event history on each
	// "agent-event" SSE message.
	function renderAgentEvents() {
		var box = document.getElementById("tab-transcript");
		var scroller = document.getElementById("transcript-tab"); // the actual overflow-y:auto element
		if (!box) return;
		roleGroupEls = {};
		var html = "";
		if (!log.length && !hasAgentEvents()) {
			box.innerHTML = '<div class="empty">waiting for agent output…</div>';
			return;
		}
		ROLES.forEach((r) => {
			var events = agentEvents[r] || [];
			if (!events.length) return;
			html +=
				'<div style="margin-bottom:12px"><div class="lrole l-' +
				r +
				'">' +
				esc(r) +
				"</div>";
			events.forEach((ev) => {
				html += formatAgentEvent(ev);
			});
			html += "</div>";
		});
		box.innerHTML = html;
		ROLES.forEach((r) => {
			const groups = box.querySelectorAll(`.lrole.l-${r}`);
			const last = groups[groups.length - 1];
			if (last) roleGroupEls[r] = last.parentElement;
		});
		if (scroller) followAppend(scroller);
	}
	function ensureAgentEventsBox() {
		const box = document.getElementById("tab-transcript");
		if (!box) return null;
		const placeholder = box.querySelector(".empty");
		if (placeholder) {
			box.innerHTML = "";
			roleGroupEls = {};
		}
		return box;
	}
	function ensureRoleGroup(box, role) {
		const existing = roleGroupEls[role];
		if (existing && box.contains(existing)) return existing;
		const wrap = document.createElement("div");
		wrap.style.marginBottom = "12px";
		const label = document.createElement("div");
		label.className = `lrole l-${role}`;
		label.textContent = role;
		wrap.appendChild(label);
		box.appendChild(wrap);
		roleGroupEls[role] = wrap;
		return wrap;
	}
	function appendAgentEvent(role, ev) {
		const tools = document.getElementById("toolsstream");
		if (tools) {
			const toolHtml = renderAgentEvent(ev);
			const placeholder = tools.querySelector(".empty");
			if (placeholder) placeholder.parentNode.removeChild(placeholder);
			if (toolHtml) {
				tools.insertAdjacentHTML(
					"beforeend",
					`<div><span class="lrole l-${role}">${esc(role)}</span>${toolHtml}</div>`,
				);
				while (tools.children.length > 200)
					tools.removeChild(tools.firstElementChild);
			}
			followAppend(tools);
		}
		const box = ensureAgentEventsBox();
		if (!box) return;
		const wrap = ensureRoleGroup(box, role);
		const html = renderAgentEvent(ev);
		if (html) {
			wrap.insertAdjacentHTML("beforeend", html);
			// Keep DOM item count roughly in line with the 100-event cap kept in
			// agentEvents[role] (label div at index 0 is never trimmed).
			while (wrap.children.length > 101) wrap.removeChild(wrap.children[1]);
		}
		const scroller = document.getElementById("transcript-tab");
		if (scroller) followAppend(scroller);
		renderEventSummary();
	}
	function hasAgentEvents() {
		for (let i = 0; i < ROLES.length; i++) {
			if (agentEvents[ROLES[i]] && agentEvents[ROLES[i]].length > 0)
				return true;
		}
		return false;
	}
	function computeEventSummary() {
		const summary = {};
		ROLES.forEach((r) => {
			const events = agentEvents[r] || [];
			events.forEach((ev) => {
				const t = ev.t || ev.type || "unknown";
				summary[t] = (summary[t] || 0) + 1;
			});
		});
		return summary;
	}
	function renderEventSummary() {
		const box = $("eventsummary");
		if (!box) return;
		const summary = computeEventSummary();
		const keys = Object.keys(summary);
		if (!keys.length) {
			box.innerHTML = '<div class="empty">no events yet\u2026</div>';
			return;
		}
		let html = "<table><tr><th>event</th><th>count</th></tr>";
		keys.forEach((k) => {
			html += `<tr><td>${esc(k)}</td><td>${summary[k]}</td></tr>`;
		});
		html += "</table>";
		box.innerHTML = html;
	}
	function formatAgentEvent(ev) {
		const t = ev.t || ev.type || "unknown";
		const part = ev.part || {};
		if (t === "step_start") return "";

		// Determine badge class and icon based on event type
		let badgeClass = "badge pending"; // default
		let icon = "·"; // default

		switch (t) {
			case "init":
				badgeClass = "badge running";
				icon = "";
				break;
			case "text":
				badgeClass = "badge running";
				icon = "";
				break;
			case "tool_call":
				badgeClass = "badge running";
				icon = "⚙";
				break;
			case "tool_result":
				// Check if ok to determine if done or failed
				if (ev.ok !== undefined && !ev.ok) {
					badgeClass = "badge failed";
					icon = "✗";
				} else {
					badgeClass = "badge done";
					icon = "✓";
				}
				break;
			case "step_finish":
				badgeClass = "badge done";
				icon = "✓";
				break;
			case "error":
				badgeClass = "badge failed";
				icon = "✗";
				break;
			case "result":
				badgeClass = "badge done";
				icon = "✓";
				break;
			case "telemetry":
				if (ev.event === "provider_completion") {
					if (ev.status === "completed") {
						badgeClass = "badge done";
						icon = "\u2713";
					} else {
						badgeClass = "badge failed";
						icon = "\u2717";
					}
				} else if (ev.event === "reservation") {
					badgeClass = "badge running";
					icon = "\u25c6";
				} else if (ev.event === "reservation_rejection") {
					badgeClass = "badge failed";
					icon = "\u2717";
				} else if (ev.event === "retry") {
					badgeClass = "badge pending";
					icon = "\u21bb";
				} else {
					badgeClass = "badge pending";
					icon = "\u2666";
				}
				break;
			case "reservation":
				badgeClass = "badge running";
				icon = "\u25c6";
				break;
			case "reservation_rejection":
				badgeClass = "badge failed";
				icon = "\u2717";
				break;
			case "retry":
				badgeClass = "badge pending";
				icon = "\u21bb";
				break;
			case "tool_use":
				badgeClass = "badge running";
				icon = "⚙";
				break;
			default:
				badgeClass = "badge pending";
				icon = "·";
				break;
		}

		let html = `<div class="activity-item"><span class="badge ${badgeClass}">${esc(icon)}</span><span class="a-type">${esc(t)}</span>`;
		if (t === "init") {
			const parts = [];
			if (ev.role) parts.push(`role: ${esc(ev.role)}`);
			if (ev.model) parts.push(`model: ${esc(ev.model)}`);
			if (ev.provider) parts.push(`provider: ${esc(ev.provider)}`);
			if (ev.sessionId) parts.push(`session: ${esc(ev.sessionId)}`);
			if (parts.length)
				html += `<div class="a-text">${esc(parts.join(" · "))}</div>`;
		} else if (t === "text" && typeof part.text === "string") {
			html += `<div class="a-text">${esc(part.text.slice(0, 500))}</div>`;
		} else if (t === "tool_call") {
			const name = `⚙ ${ev.name || ""}`;
			html += ` <span class="a-tool">${esc(name)}</span>`;
			if (ev.input) {
				let preview =
					ev.input.command ||
					ev.input.filePath ||
					ev.input.pattern ||
					ev.input.url ||
					ev.input.query ||
					"";
				if (!preview && Object.keys(ev.input).length) {
					try {
						preview = JSON.stringify(ev.input);
					} catch (_) {
						preview = "";
					}
				}
				if (preview)
					html += `<div class="a-text">${esc(preview.slice(0, 120))}</div>`;
			}
		} else if (t === "tool_result") {
			const name = `⚙ ${ev.name || ""}`;
			const ok = ev.ok ? "✓" : "✗";
			html += ` <span class="a-tool">${esc(name)}</span>`;
			html += ` <span class="a-result">${ok}</span>`;
			if (ev.ms !== undefined)
				html += ` <span class="a-result">${ev.ms}ms</span>`;
			if (ev.bytesOut !== undefined)
				html += ` <span class="a-result">${ev.bytesOut}B</span>`;
		} else if (t === "step_finish") {
			const usage = ev.usage || ev.tokens || (part.tokens ? part.tokens : {});
			const cost =
				typeof ev.costUsd === "number"
					? ev.costUsd
					: typeof part.cost === "number"
						? part.cost
						: 0;
			let summary = "";
			if (usage.input) summary += `in ${usage.input}`;
			if (usage.output) summary += `${summary ? " · " : ""}out ${usage.output}`;
			if (usage.reasoning)
				summary += `${summary ? " · " : ""}reasoning ${usage.reasoning}`;
			if (usage.cached)
				summary += `${summary ? " · " : ""}cached ${usage.cached}`;
			if (cost) summary += `${summary ? " · " : ""}$${cost.toFixed(6)}`;
			if (summary) html += ` <span class="a-result">·</span> ${esc(summary)}`;
		} else if (t === "error") {
			const errMsg = ev.error || ev.message || "unknown error";
			html += `<div class="a-text" style="color:var(--red)">${esc(fmtErr(errMsg).slice(0, 500))}</div>`;
		} else if (t === "result" && typeof ev.text === "string") {
			html += `<div class="a-text">${esc(ev.text.slice(0, 500))}</div>`;
		} else if (t === "telemetry") {
			const telemetry = [];
			if (ev.event) telemetry.push(String(ev.event));
			if (ev.status) telemetry.push(String(ev.status));
			if (ev.model) telemetry.push(`model: ${String(ev.model)}`);
			if (ev.ms !== undefined) telemetry.push(`${ev.ms}ms`);
			if (ev.requestId) telemetry.push(`request: ${String(ev.requestId)}`);
			if (ev.blockedDimension)
				telemetry.push(`blocked: ${String(ev.blockedDimension)}`);
			if (ev.waitMs !== undefined) telemetry.push(`wait: ${ev.waitMs}ms`);
			if (ev.reservationId)
				telemetry.push(`reservation: ${String(ev.reservationId)}`);
			if (telemetry.length)
				html += `<div class="a-text">${esc(telemetry.join(" · "))}</div>`;
		} else if (t === "reservation") {
			const parts = [];
			if (ev.model) parts.push(`model: ${esc(ev.model)}`);
			if (ev.status) parts.push(String(ev.status));
			if (ev.reservationId) parts.push(`reservation: ${esc(ev.reservationId)}`);
			if (parts.length)
				html += `<div class="a-text">${esc(parts.join(" · "))}</div>`;
		} else if (t === "reservation_rejection") {
			const parts = [];
			if (ev.blockedDimension)
				parts.push(`blocked: ${esc(ev.blockedDimension)}`);
			if (ev.waitMs !== undefined) parts.push(`wait: ${ev.waitMs}ms`);
			if (ev.model) parts.push(`model: ${esc(ev.model)}`);
			if (parts.length)
				html += `<div class="a-text">${esc(parts.join(" · "))}</div>`;
		} else if (t === "retry") {
			const parts = [];
			if (ev.attempt !== undefined) parts.push(`attempt: ${ev.attempt}`);
			if (ev.waitMs !== undefined) parts.push(`wait: ${ev.waitMs}ms`);
			if (ev.model) parts.push(`model: ${esc(ev.model)}`);
			if (parts.length)
				html += `<div class="a-text">${esc(parts.join(" · "))}</div>`;
		} else if (t === "tool_use" || part.type === "tool") {
			const name = `⚙ ${part.tool || ""}`;
			html += ` <span class="a-tool">${esc(name)}</span>`;
			const status =
				part.state && part.state.status === "completed" ? "✓" : "✗";
			html += ` <span class="a-result">${status}</span>`;
			const input = part.state?.input || {};
			let preview =
				input.command ||
				input.filePath ||
				input.pattern ||
				input.url ||
				input.query ||
				"";
			if (!preview && Object.keys(input).length) {
				try {
					preview = JSON.stringify(input);
				} catch (_) {
					preview = "";
				}
			}
			if (preview)
				html += `<div class="a-text">${esc(preview.slice(0, 120))}</div>`;
			if (status === "✗" && part.state && part.state.output) {
				html += `<div class="a-text">${esc(String(part.state.output).slice(0, 200))}</div>`;
			}
		} else {
			html += `<code>${esc(JSON.stringify(ev).slice(0, 120))}</code>`;
		}
		html += "</div>";
		return html;
	}
	// Shared event-row renderer: single formatter feeding BOTH live sinks —
	// the #toolsstream feed and the mirrored #tab-transcript tab.
	function renderAgentEvent(ev) {
		return formatAgentEvent(ev);
	}
	function applyState(s) {
		if (s.dash) {
			dash = s.dash;
			renderMeta();
			renderAgents();
			renderCallStats();
		}
		if (s.gh) renderGh(s.gh);
		if (s.agentEvents && !agentEventsSeeded) {
			agentEvents = s.agentEvents;
			agentEventsSeeded = true;
			// Always rebuild here, regardless of curTab: the transcript DOM is now
			// maintained incrementally (appendAgentEvent), and nothing re-renders
			// it on tab switch. Gating this on curTab === "transcript" left the
			// pane stale forever after a reconnect/snapshot arrived while the user
			// was on a different tab.
			renderAgentEvents();
			renderEventSummary();
		}
		if (s.outputs && !logSeeded) {
			log = [];
			ROLES.forEach((r) => {
				(s.outputs[r] || []).forEach((chunk) => {
					String(chunk)
						.split(String.fromCharCode(10))
						.forEach((t) => {
							if (t === "") return;
							log.push({ r: r, t: t });
							if (log.length > 200) log.shift();
						});
				});
			});
			logSeeded = true;
			renderLog();
		}
		if (Array.isArray(s.errorLog)) {
			errorLog = s.errorLog;
			if (curTab === "errorlog") renderErrorLog();
		}
		if (typeof s.runActive === "boolean") runActive = s.runActive;
		if (typeof s.queueMode === "boolean") queueMode = s.queueMode;
		if (typeof s.stopRequested === "boolean") stopRequested = s.stopRequested;
		if (s.provider && providers.indexOf(s.provider) !== -1) {
			const prev = provider;
			provider = s.provider;
			if (prev !== provider && modelsLoaded) fetchModels();
		}
		if (typeof s.notice !== "undefined") renderNotice(s.notice);
		if (typeof s.nextScanAt !== "undefined") {
			nextScanAt = s.nextScanAt;
			renderScanTimer();
		}
		renderPause(s);
		renderStop();
		syncModelsPanel();
		syncStartPanel();
	}
	function resync() {
		fetch("/api/state")
			.then((r) => r.json())
			.then((s) => {
				applyState(s);
			})
			.catch(() => {});
	}
	var QUOTA_EXHAUSTED_MSG =
		"All Gemini models RPD exhausted — change your API key. Run paused.";
	var PAUSED_BANNER_MSG =
		"All models RPD exhausted — change GEMINI_API_KEY, then Resume";
	var pausedFlag = false;
	function showToast(text) {
		var wrap = $("toasts");
		if (!wrap) return;
		var el = document.createElement("div");
		el.className = "toast";
		el.textContent = text;
		wrap.appendChild(el);
		setTimeout(() => {
			if (el.parentNode) el.parentNode.removeChild(el);
		}, 6000);
	}
	function showQuotaExhausted(text) {
		var banner = $("quotabanner"),
			label = $("quotabanner-text");
		if (label) label.textContent = text;
		if (banner) {
			banner.hidden = false;
			banner.style.display = "";
		}
		try {
			if ("Notification" in window && Notification.permission === "granted") {
				new Notification("Fleet: Gemini quota exhausted", { body: text });
			}
		} catch (_) {}
	}
	function handleQuotaEvent(q) {
		if (!q?.type) return;
		if (q.type === "model_switch") {
			const wait =
				q.waitMs > 0 ? ` (wait ~${Math.round(q.waitMs / 1000)}s)` : "";
			showToast(
				`⚠ ${q.role}: ${q.fromModel} rate limited (${q.block}) → switching to ${q.toModel}${wait}`,
			);
		} else if (q.type === "model_recovered") {
			showToast(`✓ ${q.role}: ${q.model} available again → switching back`);
		} else if (q.type === "all_models_exhausted") {
			showQuotaExhausted(QUOTA_EXHAUSTED_MSG);
		}
	}
	function hideQuotaBanner() {
		var banner = $("quotabanner");
		if (banner) {
			banner.hidden = true;
			banner.style.display = "none";
		}
		var label = $("quotabanner-text");
		if (label) label.textContent = "";
	}
	// Quota-pause banner: server-driven via snapshot.paused so it survives SSE
	// reconnects; the resume button POSTs /api/resume and hides optimistically
	// pending the authoritative state broadcast.
	function renderPause(s) {
		const btn = $("resumebtn");
		if (!btn) return;
		if (s.paused === true) {
			const entering = !pausedFlag;
			pausedFlag = true;
			const banner = $("quotabanner"),
				label = $("quotabanner-text");
			if (label) label.textContent = PAUSED_BANNER_MSG;
			if (banner) {
				banner.hidden = false;
				banner.style.display = "";
			}
			btn.hidden = false;
			if (entering) notifyPaused();
			renderStop();
		} else if (s.paused === false && pausedFlag) {
			pausedFlag = false;
			btn.hidden = true;
			hideQuotaBanner();
		}
	}
	function notifyPaused() {
		try {
			if ("Notification" in window && Notification.permission === "granted") {
				new Notification("Fleet: run paused — Gemini quota exhausted", {
					body: PAUSED_BANNER_MSG,
				});
			}
		} catch (_) {}
	}
	function requestResume() {
		var btn = $("resumebtn");
		if (!pausedFlag) return;
		if (btn) btn.hidden = true;
		fetch("/api/resume", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		})
			.then((r) => r.json())
			.then((d) => {
				if (!d?.ok) resync();
			})
			.catch(() => {
				resync();
			});
	}
	function startQueue() {
		if (runActive) return;
		var value = $("repoinput").value;
		if (!value.trim()) {
			renderNotice(
				"Enter a repo (owner/name or https://github.com/owner/name)",
			);
			return;
		}
		runActive = true;
		stopRequested = false;
		pausedFlag = false;
		hideQuotaBanner();
		renderStop();
		renderNotice("Starting…");
		fetch("/api/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repo: value, provider: provider }),
		})
			.then((r) => {
				if (r.status >= 400) {
					return r
						.json()
						.catch(() => ({}))
						.then((d) => ({
							ok: false,
							error: d?.error || `start rejected (${r.status})`,
						}));
				}
				return r.json();
			})
			.then((d) => {
				if (d?.ok) {
					renderNotice("Queue started…");
				} else {
					runActive = false;
					stopRequested = false;
					renderStop();
					renderNotice(d?.error || "start failed");
					resync();
				}
			})
			.catch(() => {
				runActive = false;
				stopRequested = false;
				renderStop();
				renderNotice("start failed — network error");
			});
	}
	function stopPoll() {
		if (pollT) {
			clearInterval(pollT);
			pollT = null;
		}
	}
	function startPoll() {
		stopPoll();
		if (reconnectT) {
			clearTimeout(reconnectT);
			reconnectT = null;
		}
		setConn(false, "reconnecting (polling)");
		logSeeded = false;
		agentEventsSeeded = false;
		pollT = setInterval(() => {
			fetch("/api/state")
				.then((r) => r.json())
				.then((s) => {
					applyState(s);
				})
				.catch(() => {});
		}, 2000);
	}
	function parseEv(e) {
		try {
			return JSON.parse(e.data);
		} catch (_err) {
			return null;
		}
	}
	function startSSE() {
		if (es) {
			es.close();
			es = null;
		}
		es = new EventSource("/api/events");
		es.addEventListener("snapshot", (e) => {
			var d = parseEv(e);
			if (d) {
				logSeeded = false;
				agentEventsSeeded = false;
				applyState(d);
			}
		});
		es.addEventListener("state", (e) => {
			var d = parseEv(e);
			if (d) applyState(d);
		});
		es.addEventListener("gh", (e) => {
			var d = parseEv(e);
			if (d) renderGh(d);
		});
		es.addEventListener("models", (e) => {
			var d = parseEv(e);
			if (!d) return;
			if (modelsRetryT) {
				clearTimeout(modelsRetryT);
				modelsRetryT = null;
			}
			modelsLoaded = true;
			if (d.provider && providers.indexOf(d.provider) !== -1)
				provider = d.provider;
			renderModels(d);
			renderProvider();
		});
		es.addEventListener("provider", (e) => {
			const d = parseEv(e);
			if (d?.provider && providers.indexOf(d.provider) !== -1) {
				const prev = provider;
				provider = d.provider;
				renderProvider();
				if (prev !== provider && modelsLoaded) fetchModels();
			}
		});
		es.addEventListener("output", (e) => {
			var d = parseEv(e);
			if (d) pushText(d.role, d.text);
		});
		es.addEventListener("agent-event", (e) => {
			var d = parseEv(e);
			if (d) pushAgentEvent(d.role, d.event);
		});
		es.addEventListener("quota_event", (e) => {
			var d = parseEv(e);
			if (d) handleQuotaEvent(d.event);
		});
		es.onopen = () => {
			setConn(true, "live");
			stopPoll();
			sseRetries = 0;
		};
		es.onerror = () => {
			setConn(false, "reconnecting…");
			if (es) {
				es.close();
				es = null;
			}
			if (reconnectT) {
				clearTimeout(reconnectT);
				reconnectT = null;
			}
			if (sseRetries >= 5) {
				startPoll();
				return;
			}
			sseRetries += 1;
			reconnectT = setTimeout(startSSE, 2000);
		};
	}
	function safe(name, fn) {
		try {
			fn();
		} catch (e) {
			console.warn("[dash:init]", name, e);
		}
	}
	function onLoad() {
		safe("elements", () => {
			connEl = $("conn");
			logEl = $("log");
			metaEl = $("meta");
			noticeEl = $("notice");
			scantimerEl = $("scantimer");
		});
		safe("meta-render", renderMeta);
		safe("agents-render", renderAgents);
		safe("stop-render", renderStop);
		safe("startpanel-sync", syncStartPanel);
		safe("gh-banner-listeners", () => {
			$("ghrecheck").addEventListener("click", fetchGh);
			$("ghlogin").addEventListener("click", startLogin);
			$("ghcodecopy").addEventListener("click", () => {
				copyText($("ghuserCode").textContent, $("ghcodecopy"));
			});
		});
		safe("run-controls", () => {
			$("startbtn").addEventListener("click", startQueue);
			$("stopbtn").addEventListener("click", requestStop);
			$("resumebtn").addEventListener("click", requestResume);
			$("repoinput").addEventListener("keydown", (e) => {
				if (e.key === "Enter") startQueue();
			});
		});
		safe("provider-buttons", () => {
			const providerBtns = document.querySelectorAll(".provider-btn");
			for (let pi = 0; pi < providerBtns.length; pi++) {
				providerBtns[pi].addEventListener("click", function () {
					if (runActive) return;
					postProvider(this.getAttribute("data-provider"));
				});
			}
			renderProvider();
		});
		safe("models-fetch", () => {
			modelsLoaded = true;
			fetchModels();
		});
		safe("gh-poll", () => {
			fetchGh();
			setInterval(fetchGh, 5000);
		});
		safe("scroll-manager", installFollowScroll);
		safe("file-refresh-poll", () => {
			setInterval(() => {
				if (curTab === "memory") fetchMemory();
				if (curTab === "sessionlog") fetchSessionLog();
			}, 5000);
		});
		fetch("/api/state")
			.then((r) => r.json())
			.then((s) => {
				applyState(s);
				startSSE();
			})
			.catch(() => {
				startPoll();
			});
	}
	document.addEventListener("DOMContentLoaded", onLoad);
})();
