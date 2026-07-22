// ==UserScript==
// @name         Monitor de Chamados SMAX
// @namespace    http://tampermonkey.net/
// @version      1.6.0
// @description  Avisa com notificação do Windows quando um chamado novo (ou que voltou a exigir atenção) é atribuído a você no SMAX.
// @author       Leonardo
// @match        https://suporte.tjsp.jus.br/*
// @grant        none
// ==/UserScript==

/*
 * Reproduz exatamente o filtro que a própria tela nativa do SMAX usa para a
 * fila "meus chamados em aberto" (capturado via DevTools em 2026-07-16):
 * grupo dentro das GSEs de suporte, Active=true, AssignedToPerson = você,
 * fase != Fechar/Aceitar, e status operacional fora das situações de
 * "aguardando cliente/outro nível". Um chamado entra nessa lista tanto
 * quando é recém-atribuído quanto quando volta de um status de espera
 * (ex.: cliente respondeu) — os dois casos disparam notificação.
 */

(function () {
    "use strict";

    const PERSON_ID = "9922370";
    const GROUP_IDS = [
        "51642955", "51642761", "51642956", "51644373", "51643315", "51642766",
        "51642767", "51642772", "51643432", "51642957", "51643437", "51642954",
        "66561429", "67109543", "61730998"
    ];
    const STATUS_EXCLUDED = [
        "AguardandoClienteContato1DiaZero_c", "AguardandoClienteContato1_c",
        "AguardandoClienteContato2_c", "AguardandoClienteContato3_c",
        "Aguardando3Nivel_c", "AguardandoOutraEquipe_c", "AguardandoInformacaoProcedimento_c"
    ];
    const LAYOUT = "Id,Description,RequestedForPerson,RequestedForPerson.Name,RequestedForPerson.IsVIP,CreateTime,StatusSCCDSMAX_c,PhaseId";
    const POLL_INTERVAL_MS = 60000;
    const STORAGE_KNOWN = "tjsp_monitor_known_ids";
    const STORAGE_PENDING = "tjsp_monitor_pending";
    const STORAGE_SOUND = "tjsp_monitor_sound";
    const STORAGE_ALERT_MODE = "tjsp_monitor_alert_mode";
    const STORAGE_VOICE_URI = "tjsp_monitor_voice_uri";
    const SOUND_PRESETS = {
        padrao: { label: "Padrão", tones: [{ freq: 880, duration: 0.5 }] },
        suave: { label: "Suave", tones: [{ freq: 660, duration: 0.4 }] },
        duplo: { label: "Alerta duplo", tones: [{ freq: 740, duration: 0.16 }, { freq: 740, duration: 0.16, delay: 0.22 }] },
        sino: { label: "Sino", tones: [{ freq: 988, duration: 0.3 }, { freq: 1318, duration: 0.5, delay: 0.12 }] }
    };

    // ============================================================
    // REDE / CSRF
    // ============================================================
    function getRestBase() {
        for (const entry of performance.getEntriesByType("resource")) {
            const match = String(entry.name || "").match(/^(https?:\/\/[^/]+\/rest\/\d+)/i);
            if (match) return match[1];
        }
        return location.origin + "/rest/213963628";
    }

    function getXsrfToken() {
        const names = ["XSRF-TOKEN", "X-XSRF-TOKEN", "CSRF-TOKEN", "X-CSRF-TOKEN"];
        for (const part of String(document.cookie || "").split(";")) {
            const pos = part.indexOf("=");
            if (pos < 0) continue;
            const name = part.slice(0, pos).trim();
            if (!names.includes(name)) continue;
            const value = part.slice(pos + 1).trim();
            try { return decodeURIComponent(value); } catch (_) { return value; }
        }
        for (const storage of [sessionStorage, localStorage]) {
            for (const name of [...names, "xsrfToken", "csrfToken"]) {
                try { const value = storage.getItem(name); if (value) return value; } catch (_) {}
            }
        }
        return "";
    }

    function requestHeaders() {
        const headers = { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest", "X-Requested-By": "XMLHttpRequest" };
        const token = getXsrfToken();
        if (token) { headers["X-XSRF-TOKEN"] = token; headers["X-CSRF-TOKEN"] = token; }
        return headers;
    }

    async function fetchJson(url, options) {
        const response = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
        const raw = await response.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
        if (!response.ok) throw new Error(data.message || data.developer_message || data.raw || `HTTP ${response.status}`);
        return data;
    }

    function htmlToText(html) {
        const box = document.createElement("div");
        box.innerHTML = String(html || "");
        return (box.textContent || "").replace(/\s+/g, " ").trim();
    }

    function truncate(text, max) {
        return text.length > max ? text.slice(0, max - 1).trim() + "…" : text;
    }

    function formatClock(createTime) {
        const date = new Date(Number(createTime));
        return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    function formatElapsed(createTime) {
        const ms = Date.now() - Number(createTime);
        if (!Number.isFinite(ms) || ms < 0) return "";
        const minutes = Math.floor(ms / 60000);
        if (minutes < 1) return "agora mesmo";
        if (minutes < 60) return `há ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        if (hours < 24) return remMinutes ? `há ${hours}h ${remMinutes}min` : `há ${hours}h`;
        const days = Math.floor(hours / 24);
        return `há ${days} dia(s)`;
    }

    // ============================================================
    // CONSULTA
    // ============================================================
    function buildFilter() {
        const groupClause = GROUP_IDS.map(id => `AssignedToGroup = '${id}'`).join(" or ");
        const phaseClause = "(PhaseId != 'Close' and PhaseId != 'Accept' or PhaseId = null)";
        const statusClause = "(" + STATUS_EXCLUDED.map(s => `StatusSCCDSMAX_c != '${s}'`).join(" and ") + " or StatusSCCDSMAX_c = null)";
        return `((${groupClause}) and Active = 'true' and AssignedToPerson = '${PERSON_ID}' and ${phaseClause} and ${statusClause})`;
    }

    function buildUrl() {
        const params = new URLSearchParams();
        params.set("filter", buildFilter());
        params.set("layout", LAYOUT);
        params.set("meta", "totalCount");
        params.set("order", "CreateTime desc");
        params.set("size", "250");
        params.set("skip", "0");
        return `${getRestBase()}/ems/Request?${params}`;
    }

    async function fetchActiveTickets() {
        const payload = await fetchJson(buildUrl(), { method: "GET", headers: requestHeaders() });
        const entities = Array.isArray(payload.entities) ? payload.entities : [];
        const tickets = new Map();
        entities.forEach(entity => {
            const p = entity.properties || {};
            const id = String(p.Id || "");
            if (!id) return;
            const requester = (entity.related_properties && entity.related_properties.RequestedForPerson) || {};
            const requestedFor = requester.Name || "Não informado";
            const isVip = requester.IsVIP === true || requester.IsVIP === "true";
            tickets.set(id, { id, description: htmlToText(p.Description), requestedFor, createTime: p.CreateTime || "", isVip });
        });
        return tickets;
    }

    // ============================================================
    // PERSISTÊNCIA
    // ============================================================
    function loadJson(key, fallback) {
        try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
        catch (_) { return fallback; }
    }
    function saveJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
    }

    // ============================================================
    // NOTIFICAÇÃO (som + notificação do Windows)
    // ============================================================
    const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#1a73c7"/><path d="M32 15a11 11 0 0 0-11 11v7l-4.5 6.5h31L43 33v-7a11 11 0 0 0-11-11z" fill="#fff"/><circle cx="32" cy="47" r="4.2" fill="#fff"/></svg>';
    const ICON_DATA_URI = "data:image/svg+xml;utf8," + encodeURIComponent(ICON_SVG);

    function playBeep() {
        const presetName = loadJson(STORAGE_SOUND, "padrao");
        const preset = SOUND_PRESETS[presetName] || SOUND_PRESETS.padrao;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            preset.tones.forEach(tone => {
                const start = ctx.currentTime + (tone.delay || 0);
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = tone.freq;
                gain.gain.value = 0.16;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(start);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
                osc.stop(start + tone.duration + 0.02);
            });
        } catch (_) {}
    }

    function getAlertMode() {
        return loadJson(STORAGE_ALERT_MODE, "sound");
    }

    function speak(text, voiceURI) {
        if (typeof speechSynthesis === "undefined") return;
        try {
            speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = "pt-BR";
            utterance.rate = 1;
            utterance.volume = 1;
            if (voiceURI) {
                const voice = speechSynthesis.getVoices().find(item => item.voiceURI === voiceURI);
                if (voice) utterance.voice = voice;
            }
            speechSynthesis.speak(utterance);
        } catch (_) {}
    }

    function voicePhraseFor(tickets) {
        const anyVip = tickets.some(ticket => ticket.isVip);
        if (tickets.length === 1) return tickets[0].isVip ? "Novo chamado VIP alocado" : "Novo chamado alocado";
        return anyVip ? `${tickets.length} chamados novos alocados, incluindo VIP` : `${tickets.length} chamados novos alocados`;
    }

    // Toca o alerta escolhido pelo usuário: som (beep configurável) ou voz
    // (frase falada, distinguindo chamado comum de VIP). Um ou outro, nunca os dois.
    function playAlert(tickets) {
        if (getAlertMode() === "voice") speak(voicePhraseFor(tickets), loadJson(STORAGE_VOICE_URI, ""));
        else playBeep();
    }

    function fireDesktopNotification(ticket, extraCount) {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        const vipTag = ticket.isVip ? "⭐ VIP — " : "";
        const timeInfo = ticket.createTime ? `Aberto ${formatClock(ticket.createTime)} (${formatElapsed(ticket.createTime)})` : "";
        let title, body;
        if (extraCount) {
            title = `${vipTag}${extraCount + 1} chamados novos/atualizados`;
            body = `Inclui ${ticket.id} — ${ticket.requestedFor}\n${timeInfo}`;
        } else {
            title = `${vipTag}Novo chamado: ${ticket.id}`;
            body = `${ticket.requestedFor} — ${truncate(ticket.description, 90)}\n${timeInfo}`;
        }
        const notification = new Notification(title, { body, icon: ICON_DATA_URI, tag: "tjsp-chamado-" + ticket.id });
        // Notificações simples (sem Service Worker) só permitem UM clique em
        // qualquer parte do toast — não dá pra tornar só o número do chamado
        // clicável dentro da notificação nativa do Windows. Por isso o clique
        // só traz a aba de volta e abre o painel do sininho, onde o usuário
        // decide com calma se abre o chamado agora ou depois.
        notification.onclick = () => {
            window.focus();
            if (ui) ui.panel.hidden = false;
            notification.close();
        };
    }

    // ============================================================
    // INTERFACE (sino flutuante + painel de pendentes)
    // ============================================================
    let host, ui, pending;

    function buildUi() {
        host = document.createElement("div");
        host.id = "tjsp-monitor-host";
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>
            :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #273746; }
            * { box-sizing: border-box; }
            button { font: inherit; }

            .bell {
                position: fixed; bottom: 24px; right: 24px; z-index: 2147483000;
                width: 48px; height: 48px; border-radius: 50%; border: 2px solid #fff;
                background: linear-gradient(135deg, #1a73c7 0%, #12558f 100%); color: #fff;
                box-shadow: 0 4px 14px rgba(0,0,0,.3); cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: transform .15s, box-shadow .15s;
            }
            .bell:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,0,0,.4); }
            .bell svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 2; }
            .bell.has-pending::after {
                content: ''; position: absolute; inset: -6px; border-radius: 50%;
                border: 2px solid #1a73c7; opacity: .6; animation: tjspMonitorPulso 2.2s ease-out infinite; pointer-events: none;
            }
            @keyframes tjspMonitorPulso { 0% { transform: scale(.85); opacity: .6; } 100% { transform: scale(1.35); opacity: 0; } }
            .badge {
                position: absolute; top: -4px; right: -4px; min-width: 19px; height: 19px; padding: 0 4px;
                border-radius: 10px; background: #d13438; color: #fff; font-size: 11px; font-weight: 800;
                display: flex; align-items: center; justify-content: center; border: 2px solid #fff;
            }
            .badge[hidden] { display: none; }

            .panel {
                position: fixed; bottom: 80px; right: 24px; z-index: 2147483000;
                width: min(380px, calc(100vw - 32px)); max-height: min(70vh, 560px);
                background: #fff; border: 1px solid #cdd8e3; border-radius: 12px;
                box-shadow: 0 20px 50px rgba(16,39,64,.3); overflow: hidden; display: flex; flex-direction: column;
            }
            .panel[hidden] { display: none; }
            .panel-header {
                padding: 12px 14px; background: linear-gradient(180deg, #1a73c7, #12558f); color: #fff;
                display: flex; align-items: center; gap: 8px; flex-shrink: 0;
            }
            .panel-header strong { flex: 1; font-size: 14px; }
            .panel-header button { flex-shrink: 0; border: 1px solid rgba(255,255,255,.35); background: rgba(255,255,255,.12); color: #fff; border-radius: 6px; height: 26px; padding: 0 9px; font-size: 11px; cursor: pointer; }
            .panel-header button:hover { background: rgba(255,255,255,.22); }
            .settings-row { display: flex; align-items: center; gap: 8px; padding: 7px 14px; background: #f6f9fb; border-bottom: 1px solid #e3eaf0; flex-shrink: 0; }
            .settings-row[hidden] { display: none; }
            .settings-row label { flex-shrink: 0; width: 46px; font-size: 11px; font-weight: 700; color: #526477; text-transform: uppercase; letter-spacing: .03em; }
            .settings-row select { flex: 1; height: 28px; padding: 0 8px; border: 1px solid #cfd9e2; border-radius: 6px; background: #fff; color: #273746; font-size: 12px; min-width: 0; }
            .settings-row .test-voice { flex-shrink: 0; height: 28px; padding: 0 10px; border: 1px solid #cfe4f7; background: #eaf4fd; color: #12558f; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
            .settings-row .test-voice:hover { background: #d5e9fa; }
            .panel-list { overflow: auto; flex: 1; }
            .ticket-item { display: block; width: 100%; text-align: left; padding: 11px 14px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid #eef2f6; background: #fff; cursor: pointer; }
            .ticket-item:hover { background: #eaf4fd; }
            .ticket-item.vip { border-left-color: #d4a017; background: #fffbf0; }
            .ticket-item.vip:hover { background: #fff4d6; }
            .ticket-item .id-row { display: flex; align-items: center; gap: 6px; }
            .ticket-item .id { color: #12558f; font-weight: 800; font-size: 13px; }
            .ticket-item .vip-badge { font-size: 10px; font-weight: 800; color: #8a6300; background: #ffe9a8; border-radius: 4px; padding: 1px 6px; }
            .ticket-item .who { color: #1f2d3d; font-weight: 700; font-size: 12.5px; margin: 4px 0 3px; }
            .ticket-item .time { display: flex; align-items: center; gap: 4px; color: #3e5266; font-weight: 600; font-size: 11.5px; margin-bottom: 5px; }
            .ticket-item .time svg { width: 12px; height: 12px; fill: none; stroke: #5b81a3; stroke-width: 2; flex-shrink: 0; }
            .ticket-item .desc { color: #576475; font-size: 11.5px; line-height: 1.45; }
            .empty { padding: 28px 16px; text-align: center; color: #6b7887; font-size: 12.5px; }
            .permission-bar { padding: 10px 14px; background: #fff7df; color: #795912; font-size: 12px; border-bottom: 1px solid #f0e2b3; display: flex; flex-direction: column; gap: 6px; }
            .permission-bar .row { display: flex; align-items: center; gap: 8px; }
            .permission-bar button { flex-shrink: 0; height: 26px; padding: 0 10px; border: 1px solid #12558f; background: #1a73c7; color: #fff; border-radius: 6px; font-size: 11px; cursor: pointer; }
            .permission-bar[hidden] { display: none; }
            .permission-bar.denied { background: #fff0ef; color: #a11f19; border-color: #f3c9c7; }
            .permission-bar .status-line { font-size: 11.5px; }
        </style>
        <button class="bell" type="button" title="Chamados atribuídos a você"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg><span class="badge" hidden>0</span></button>
        <section class="panel" hidden>
            <div class="permission-bar" hidden><div class="row"><span>Ative as notificações do Windows para ser avisado mesmo com a aba minimizada.</span><button class="enable-notifications" type="button">Ativar</button></div><div class="status-line" hidden></div></div>
            <header class="panel-header"><strong>Chamados novos</strong><button class="simulate" type="button" title="Gera um chamado fictício para testar som/notificação">Simular</button><button class="mark-read" type="button">Marcar tudo como lido</button></header>
            <div class="settings-row"><label>Alerta</label><select class="alert-mode-select"><option value="sound">Som</option><option value="voice">Voz</option></select></div>
            <div class="settings-row sound-row"><label>Som</label><select class="sound-select"></select></div>
            <div class="settings-row voice-row"><label>Voz</label><select class="voice-select"></select><button class="test-voice" type="button">Testar</button></div>
            <div class="panel-list"><div class="empty">Nenhum chamado pendente no momento.</div></div>
        </section>`;

        ui = {
            bell: shadow.querySelector(".bell"),
            badge: shadow.querySelector(".badge"),
            panel: shadow.querySelector(".panel"),
            list: shadow.querySelector(".panel-list"),
            markRead: shadow.querySelector(".mark-read"),
            simulate: shadow.querySelector(".simulate"),
            permissionBar: shadow.querySelector(".permission-bar"),
            enableNotifications: shadow.querySelector(".enable-notifications"),
            statusLine: shadow.querySelector(".status-line"),
            soundSelect: shadow.querySelector(".sound-select"),
            alertModeSelect: shadow.querySelector(".alert-mode-select"),
            soundRow: shadow.querySelector(".sound-row"),
            voiceRow: shadow.querySelector(".voice-row"),
            voiceSelect: shadow.querySelector(".voice-select"),
            testVoice: shadow.querySelector(".test-voice")
        };

        Object.keys(SOUND_PRESETS).forEach(key => {
            const option = document.createElement("option");
            option.value = key;
            option.textContent = SOUND_PRESETS[key].label;
            ui.soundSelect.appendChild(option);
        });
        ui.soundSelect.value = loadJson(STORAGE_SOUND, "padrao");
        ui.soundSelect.addEventListener("change", () => {
            saveJson(STORAGE_SOUND, ui.soundSelect.value);
            playBeep();
        });

        function updateAlertModeRows() {
            const mode = ui.alertModeSelect.value;
            ui.soundRow.hidden = mode !== "sound";
            ui.voiceRow.hidden = mode !== "voice";
        }
        ui.alertModeSelect.value = getAlertMode();
        updateAlertModeRows();
        ui.alertModeSelect.addEventListener("change", () => {
            saveJson(STORAGE_ALERT_MODE, ui.alertModeSelect.value);
            updateAlertModeRows();
        });

        function populateVoiceOptions() {
            if (typeof speechSynthesis === "undefined") return;
            const voices = speechSynthesis.getVoices();
            if (!voices.length) return;
            const ptVoices = voices.filter(voice => voice.lang && voice.lang.toLowerCase().startsWith("pt"));
            const list = ptVoices.length ? ptVoices : voices;
            const current = loadJson(STORAGE_VOICE_URI, "");
            ui.voiceSelect.innerHTML = "";
            list.forEach(voice => {
                const option = document.createElement("option");
                option.value = voice.voiceURI;
                option.textContent = `${voice.name} (${voice.lang})`;
                ui.voiceSelect.appendChild(option);
            });
            if (current && list.some(voice => voice.voiceURI === current)) ui.voiceSelect.value = current;
            else saveJson(STORAGE_VOICE_URI, list[0].voiceURI);
        }
        if (typeof speechSynthesis !== "undefined") {
            populateVoiceOptions();
            speechSynthesis.addEventListener("voiceschanged", populateVoiceOptions);
        } else {
            ui.voiceRow.hidden = true;
            if (ui.alertModeSelect.querySelector('option[value="voice"]')) ui.alertModeSelect.querySelector('option[value="voice"]').disabled = true;
        }
        ui.voiceSelect.addEventListener("change", () => saveJson(STORAGE_VOICE_URI, ui.voiceSelect.value));
        ui.testVoice.addEventListener("click", () => speak("Novo chamado alocado", ui.voiceSelect.value));

        ui.bell.addEventListener("click", () => { ui.panel.hidden = !ui.panel.hidden; });
        ui.markRead.addEventListener("click", () => { pending = []; saveJson(STORAGE_PENDING, pending); renderPending(); });
        ui.simulate.addEventListener("click", simulateNewTicket);
        // requestPermission só pode ser chamado a partir de um clique de verdade
        // como este — chamá-lo sozinho ao carregar a página (sem gesto do
        // usuário) faz o Chrome/Edge tratar como pedido "abusivo" e bloquear
        // silenciosamente, sem sequer mostrar o popup e sem re-perguntar depois.
        ui.enableNotifications.addEventListener("click", () => {
            Notification.requestPermission().then(result => {
                updatePermissionBar();
                ui.statusLine.hidden = false;
                if (result === "granted") {
                    ui.statusLine.textContent = "Notificações ativadas! Enviando um teste...";
                    new Notification("Notificações ativadas", { body: "Você vai ser avisado por aqui quando um chamado novo entrar.", icon: ICON_DATA_URI });
                } else if (result === "denied") {
                    ui.permissionBar.classList.add("denied");
                    ui.statusLine.textContent = "Bloqueado pelo navegador. Clique no cadeado/ícone ao lado do endereço do site → Notificações → Permitir, depois recarregue a página.";
                } else {
                    ui.statusLine.textContent = "Nenhuma escolha foi feita. Tente clicar em Ativar de novo.";
                }
            });
        });
        shadow.addEventListener("mousedown", event => {
            if (ui.panel.hidden) return;
            if (!event.composedPath().includes(ui.panel) && !event.composedPath().includes(ui.bell)) ui.panel.hidden = true;
        });

        updatePermissionBar();
    }

    function updatePermissionBar() {
        const supported = typeof Notification !== "undefined";
        ui.permissionBar.hidden = !supported || Notification.permission === "granted";
        if (Notification.permission !== "denied") ui.permissionBar.classList.remove("denied");
    }

    function renderPending() {
        ui.badge.hidden = pending.length === 0;
        ui.badge.textContent = String(pending.length);
        ui.bell.classList.toggle("has-pending", pending.length > 0);
        if (!pending.length) { ui.list.innerHTML = '<div class="empty">Nenhum chamado pendente no momento.</div>'; return; }
        ui.list.innerHTML = "";
        pending.slice().reverse().forEach(ticket => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "ticket-item" + (ticket.isVip ? " vip" : "");
            const vipBadge = ticket.isVip ? '<span class="vip-badge">⭐ VIP</span>' : "";
            const timeInfo = ticket.createTime ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3.5 2"></path></svg>Aberto ${formatClock(ticket.createTime)} · ${formatElapsed(ticket.createTime)}` : "";
            item.innerHTML = `<div class="id-row"><span class="id">${ticket.id}</span>${vipBadge}</div><div class="who">${ticket.requestedFor}</div><div class="time">${timeInfo}</div><div class="desc">${truncate(ticket.description, 140)}</div>`;
            item.addEventListener("click", () => {
                window.open(`${location.origin}/saw/Request/${encodeURIComponent(ticket.id)}/general`, "_blank");
                pending = pending.filter(item2 => item2.id !== ticket.id);
                saveJson(STORAGE_PENDING, pending);
                renderPending();
            });
            ui.list.appendChild(item);
        });
    }

    // ============================================================
    // SIMULAÇÃO (só para teste manual, via botão "Simular" no painel)
    // ============================================================
    const SIMULATE_DELAY_MS = 10000;

    function simulateNewTicket() {
        ui.simulate.disabled = true;
        let secondsLeft = Math.round(SIMULATE_DELAY_MS / 1000);
        const originalLabel = ui.simulate.textContent;
        ui.simulate.textContent = `Chega em ${secondsLeft}s...`;
        const countdown = setInterval(() => {
            secondsLeft -= 1;
            if (secondsLeft > 0) ui.simulate.textContent = `Chega em ${secondsLeft}s...`;
        }, 1000);

        setTimeout(() => {
            clearInterval(countdown);
            ui.simulate.disabled = false;
            ui.simulate.textContent = originalLabel;

            const ageMinutes = Math.random() < 0.5 ? 3 : 95;
            const fake = {
                id: "TESTE" + Math.floor(1000 + Math.random() * 9000),
                description: "Este é um chamado de teste gerado para simular a notificação. A parte não conseguiu gerar a guia de preparo de apelação pelo sistema e solicita apoio.",
                requestedFor: "USUÁRIO DE TESTE",
                createTime: Date.now() - ageMinutes * 60000,
                isVip: Math.random() < 0.5
            };
            pending = pending.concat(fake);
            saveJson(STORAGE_PENDING, pending);
            renderPending();
            playAlert([fake]);
            fireDesktopNotification(fake);
        }, SIMULATE_DELAY_MS);
    }

    // ============================================================
    // CICLO DE VERIFICAÇÃO
    // ============================================================
    async function checkForNewTickets() {
        try {
            const current = await fetchActiveTickets();
            const known = loadJson(STORAGE_KNOWN, null);
            const isFirstRun = known === null;
            const knownSet = new Set(known || []);
            const newTickets = [];
            current.forEach((ticket, id) => { if (!knownSet.has(id)) newTickets.push(ticket); });
            saveJson(STORAGE_KNOWN, Array.from(current.keys()));

            if (isFirstRun || !newTickets.length) return;

            pending = pending.concat(newTickets);
            saveJson(STORAGE_PENDING, pending);
            renderPending();
            playAlert(newTickets);
            newTickets.forEach((ticket, index) => fireDesktopNotification(ticket, index === 0 ? newTickets.length - 1 : undefined));
        } catch (error) {
            console.error("[TJSP Monitor] Falha ao consultar chamados:", error);
        }
    }

    function init() {
        if (document.getElementById("tjsp-monitor-host")) return;
        buildUi();
        pending = loadJson(STORAGE_PENDING, []);
        renderPending();
        checkForNewTickets();
        setInterval(checkForNewTickets, POLL_INTERVAL_MS);
        setInterval(() => { if (pending.length) renderPending(); }, 30000);
        console.log("[TJSP] Monitor de chamados 1.6.0 carregado.");
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
}());
