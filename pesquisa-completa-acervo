// ==UserScript==
// @name         TJSP Suporte - Pesquisa Completa no Acervo SMAX 
// @namespace    http://tampermonkey.net/
// @version      0.7.0
// @description  Busca exaustiva (sem corte de relevância) no acervo completo das GSEs, com filtros avançados, busca por termos OU por semelhança (BM25, 100% local, sem IA), navegação entre resultados, modo expandido, seleção para exportação e exportação em CSV/JSON/TXT/HTML.
// @author       Leonardo
// @match        https://suporte.tjsp.jus.br/saw/Requests*
// @grant        none
// ==/UserScript==

/*
 * COMO FUNCIONA:
 * 1. O SMAX bloqueia filtro de texto em Description/Solution (campo "não
 *    pesquisável" — confirmado ao vivo, erro 500 "IllegalArgumentException").
 *    Por isso a consulta ao servidor filtra SÓ por AssignedToGroup (campo
 *    estruturado, permitido); o texto é comparado inteiramente no navegador,
 *    depois que os dados já chegaram.
 * 2. O SMAX também recusa qualquer consulta cujo total combinado ultrapasse
 *    10.000 entidades (erro 400 "query.num.of.entities.exceeded" — também
 *    confirmado ao vivo). Solução: medir o total de CADA GSE individualmente
 *    e agrupar dinamicamente em lotes que fiquem sempre abaixo do teto (uma
 *    GSE muito movimentada pode ficar sozinha; várias paradas podem ir juntas
 *    no mesmo lote), paginando cada lote em paralelo até esgotar.
 * 3. Tudo fica em memória nesta aba — nada é salvo em disco, nada é enviado
 *    a lugar nenhum. As exportações (CSV/JSON/TXT/HTML) geram o arquivo
 *    localmente no navegador, sob demanda, só quando você clica.
 * 4. A busca por semelhança compara o texto colado com cada solicitação já
 *    carregada usando BM25 (o mesmo tipo de algoritmo de ranking por
 *    relevância usado por buscadores de texto como o Elasticsearch) — roda
 *    inteiramente no navegador, sem nenhuma chamada de rede ou de IA.
 */

(function () {
    "use strict";

    const VERSION = "0.7.0";
    const CONCURRENCY = 6;
    const PAGE_SIZE = 250;
    const PAGE_RESULTS = 15;
    const BATCH_SAFETY_LIMIT = 9500; // teto real do SMAX é 10.000; margem de segurança
    const OPEN_SELECTED_CAP = 15; // limite ao abrir várias abas de uma vez (evita bloqueio de pop-up)

    // Busca por semelhança (BM25) — 100% local, sem chamada de rede/IA.
    const BM25_K1 = 1.4;
    const BM25_B = 0.75;
    const SEMANTIC_MIN_TOKEN_LEN = 3;
    const SEMANTIC_DEFAULT_LIMIT = 50;
    const STOPWORDS_PT = new Set([
        "a", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo", "as", "até", "com", "como",
        "da", "das", "de", "dela", "delas", "dele", "deles", "depois", "do", "dos", "e", "ela", "elas",
        "ele", "eles", "em", "entre", "era", "eram", "essa", "essas", "esse", "esses", "esta", "estas",
        "este", "estes", "estava", "estavam", "está", "estão", "eu", "foi", "foram", "fosse", "há",
        "isso", "isto", "já", "lhe", "lhes", "mais", "mas", "me", "mesmo", "meu", "meus", "minha", "minhas",
        "muito", "muita", "muitos", "muitas", "na", "nas", "nem", "no", "nos", "nossa", "nossas", "nosso",
        "nossos", "num", "numa", "não", "nós", "o", "os", "ou", "para", "pela", "pelas", "pelo", "pelos",
        "perante", "pois", "por", "porque", "porquê", "pra", "pro", "qual", "quando", "que", "quem",
        "se", "sem", "ser", "seu", "seus", "sob", "sobre", "somos", "sua", "suas", "são", "também",
        "te", "tem", "têm", "tendo", "ter", "teu", "teus", "teve", "tinha", "tinham", "tive", "tu", "tua",
        "tuas", "um", "uma", "umas", "uns", "você", "vocês", "vos"
    ]);
    const ARCHIVE_LAYOUT = [
        "Id", "Description", "Solution", "CreateTime",
        "RequestedForPerson", "RequestedForPerson.Name", "RequestedForPerson.IsVIP",
        "AssignedToPerson", "AssignedToPerson.Name",
        "AssignedToGroup", "AssignedToGroup.Name"
    ].join(",");

    const GSES = [
        ["51642955", "GSE - SGS - EPROC 1G - ACIV"],
        ["51642761", "GSE - SGS - EPROC 1G - AEXCRIM"],
        ["51642956", "GSE - SGS - EPROC 1G - ACRIM"],
        ["51644373", "GSE - SGS - EPROC 1G - CEJUSCS"],
        ["51643315", "GSE - SGS - EPROC 1G - CERT"],
        ["51642766", "GSE - SGS - EPROC 1G - CLMAND"],
        ["51642767", "GSE - SGS - EPROC 1G - COLREC"],
        ["51642772", "GSE - SGS - EPROC 1G - DISTR"],
        ["51643432", "GSE - SGS - EPROC 1G - OFJUST"],
        ["51642957", "GSE - SGS - EPROC 1G - JUIESP"],
        ["51643437", "GSE - SGS - EPROC 1G - OAJUDS"],
        ["51642954", "GSE - SGS - EPROC - PLANTAO"],
        ["66561429", "GSE - SGS - EPROC - MIGRACAO 1G"],
        ["67109543", "GSE - SGS - EPROC 1G - HOMOLOGACAO"],
        ["61730998", "GSE - SGS - EPROC - CONFIG"]
    ];
    const GSE_NAME = Object.fromEntries(GSES);

    let host, ui;
    let archive = [];
    let archiveLoadedAt = null;
    let archiveLoading = false;
    let archiveCancelled = false;
    let results = [];
    let currentPage = 1;
    let sortMode = "recent";
    let lastQueryTerms = [];
    let activeIndex = -1;
    let focusedIndex = -1;
    let searchMode = "terms";
    let semanticIndex = null;
    let semanticScores = new Map();
    let semanticMaxScore = 1;
    const selectedIds = new Set();

    // ============================================================
    // REDE
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
        const response = await fetch(url, Object.assign({ method: "GET", credentials: "same-origin", headers: requestHeaders() }, options || {}));
        const raw = await response.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
        if (!response.ok) {
            const error = new Error((data.message) || (data.developer_message) || data.raw || `HTTP ${response.status}`);
            error.messageKey = data.message_key || "";
            throw error;
        }
        return data;
    }

    // O SMAX recusa QUALQUER consulta (mesmo pedindo 1 registro, ou uma página
    // de 250) quando o total de entidades que o filtro encontra passa de
    // 10.000 — confirmado ao vivo: uma única GSE (ACIV) já ultrapassa isso
    // sozinha. Detectamos esse erro específico pela chave estruturada (mais
    // confiável que comparar o texto traduzido da mensagem).
    function isExceededError(error) {
        return !!error && (error.messageKey === "query.num.of.entities.exceeded" || /excedeu o m.ximo/i.test(error.message || ""));
    }

    // Preserva o item original no erro (item.item) para que falhas possam ser
    // atribuídas à GSE/página correta em vez de somem sem explicação.
    async function concurrentMap(items, worker, onProgress) {
        const output = new Array(items.length);
        let cursor = 0, done = 0;
        async function runner() {
            while (!archiveCancelled) {
                const index = cursor++;
                if (index >= items.length) return;
                try { output[index] = await worker(items[index]); }
                catch (error) { output[index] = { error, item: items[index] }; }
                if (onProgress) onProgress(++done, items.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
        return output;
    }

    // ============================================================
    // MEDIÇÃO DE VOLUME + PLANEJAMENTO DE LOTES
    //
    // "Unidade" = um pedaço pesquisável com contagem confirmada abaixo do
    // teto: normalmente uma GSE inteira, mas quando uma GSE sozinha já passa
    // de 10.000 (caso real: ACIV), ela é dividida recursivamente por período
    // até cada pedaço caber. As unidades finais são então empacotadas em
    // lotes (várias unidades combinadas por "ou") para minimizar requisições.
    // ============================================================
    function combineClauses(clauses) {
        return clauses.length === 1 ? clauses[0] : "(" + clauses.join(" or ") + ")";
    }

    async function fetchFilterCount(filterClause) {
        const params = new URLSearchParams({ filter: filterClause, layout: "Id", meta: "totalCount", size: "1", skip: "0" });
        const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
        return Number((payload.meta && payload.meta.total_count) || 0);
    }

    // Restrição opcional por pessoa (Solicitado para / Designado Especialista),
    // preenchida só quando o usuário escolhe uma sugestão do autocomplete (que
    // resolve o ID exato da pessoa — o filtro nativo exige ID, não nome parcial).
    // Vazio = comportamento de sempre (carrega tudo das GSEs selecionadas).
    function personConstraintClause() {
        const clauses = [];
        const specialistId = ui.specialist.dataset.personId;
        const requesterId = ui.requestedFor.dataset.personId;
        if (specialistId) clauses.push(`AssignedToPerson = '${specialistId}'`);
        if (requesterId) clauses.push(`RequestedForPerson = '${requesterId}'`);
        return clauses.length ? clauses.join(" and ") : "";
    }

    function baseGseClause(gseId) {
        const extra = personConstraintClause();
        return extra ? `(AssignedToGroup = '${gseId}') and (${extra})` : `(AssignedToGroup = '${gseId}')`;
    }

    async function fetchGseTotal(gseId) {
        return fetchFilterCount(baseGseClause(gseId));
    }

    // A contagem por GSE é leve, então vale uma segunda tentativa automática
    // antes de desistir — falhas de rede transitórias não devem excluir uma
    // GSE inteira da carga silenciosamente. Erros de "excedeu o máximo" não
    // são reretentados aqui (são determinísticos, não transitórios) — sobem
    // direto para quem chamou tratar via divisão por data.
    async function fetchGseTotalWithRetry(gseId) {
        try { return await fetchGseTotal(gseId); }
        catch (error) {
            if (isExceededError(error)) throw error;
            await new Promise(resolve => setTimeout(resolve, 500));
            return await fetchGseTotal(gseId);
        }
    }

    const ARCHIVE_EARLIEST_TIME = new Date(2010, 0, 1).getTime();
    const ARCHIVE_LATEST_TIME = Date.now() + 86400000;
    const MIN_SPLIT_RANGE_MS = 6 * 60 * 60 * 1000; // não divide abaixo de 6h — evita recursão sem fim

    function dateRangeClause(gseId, from, to) {
        const extra = personConstraintClause();
        const base = `(AssignedToGroup = '${gseId}') and (CreateTime >= ${from} and CreateTime < ${to})`;
        return extra ? `${base} and (${extra})` : base;
    }

    // Bisecção recursiva: tenta contar o intervalo inteiro; se o SMAX recusar
    // por excesso, parte o intervalo ao meio e tenta cada metade, repetindo
    // até cada pedaço confirmar uma contagem real abaixo do teto.
    async function splitByDateUntilSafe(gseId, label, from, to, depth) {
        const clause = dateRangeClause(gseId, from, to);
        try {
            const total = await fetchFilterCount(clause);
            return [{ filterClause: clause, total, label }];
        } catch (error) {
            if (!isExceededError(error) || (to - from) <= MIN_SPLIT_RANGE_MS || (depth || 0) > 24) {
                // Não deu pra confirmar isoladamente (intervalo já mínimo); segue
                // mesmo assim com uma estimativa conservadora do teto.
                return [{ filterClause: clause, total: BATCH_SAFETY_LIMIT, label: `${label} (período muito denso, estimado)` }];
            }
            const mid = from + Math.floor((to - from) / 2);
            const left = await splitByDateUntilSafe(gseId, label, from, mid, (depth || 0) + 1);
            const right = await splitByDateUntilSafe(gseId, label, mid, to, (depth || 0) + 1);
            return left.concat(right);
        }
    }

    // Empacotamento guloso: ordena unidades da maior pra menor e vai enchendo
    // lotes sem ultrapassar o teto de segurança. Uma unidade sozinha maior que
    // o teto vira seu próprio lote (fica sinalizada, mas a tentativa segue).
    function planBatches(units) {
        const sorted = units.slice().sort((a, b) => b.total - a.total);
        const batches = [];
        for (const entry of sorted) {
            let target = batches.find(batch => batch.total + entry.total <= BATCH_SAFETY_LIMIT);
            if (!target) { target = { clauses: [], labels: [], total: 0 }; batches.push(target); }
            target.clauses.push(entry.filterClause);
            target.labels.push(entry.label);
            target.total += entry.total;
        }
        return batches;
    }

    // ============================================================
    // CARGA DO ACERVO (paginação paralela por lote)
    // ============================================================
    function htmlToText(html) {
        const box = document.createElement("div");
        box.innerHTML = String(html || "");
        box.querySelectorAll("script,style").forEach(node => node.remove());
        box.querySelectorAll("img").forEach(node => node.replaceWith(document.createTextNode("\n[Imagem anexada]\n")));
        box.querySelectorAll("br").forEach(node => node.replaceWith(document.createTextNode("\n")));
        box.querySelectorAll("li").forEach(node => {
            node.insertBefore(document.createTextNode("• "), node.firstChild);
            node.appendChild(document.createTextNode("\n"));
        });
        box.querySelectorAll("p,div,tr,section,article,h1,h2,h3,h4,h5,h6").forEach(node => node.appendChild(document.createTextNode("\n\n")));
        return (box.textContent || "")
            .replace(/ /g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
    }

    function normalizeRecord(entity) {
        const p = entity.properties || {};
        const related = entity.related_properties || {};
        const groupId = String((p.AssignedToGroup && (p.AssignedToGroup.Id || p.AssignedToGroup)) || "");
        const requester = related.RequestedForPerson || {};
        return {
            id: String(p.Id || ""),
            description: htmlToText(p.Description),
            solution: htmlToText(p.Solution),
            requestedFor: requester.Name || String(p["RequestedForPerson.Name"] || "Não informado"),
            isVip: requester.IsVIP === true || requester.IsVIP === "true",
            assignedSpecialist: (related.AssignedToPerson && related.AssignedToPerson.Name) || String(p["AssignedToPerson.Name"] || "Não informado"),
            groupId,
            groupName: GSE_NAME[groupId] || groupId || "Não informado",
            created: p.CreateTime || ""
        };
    }

    async function fetchBatchPage(filterClause, skip) {
        const params = new URLSearchParams({ filter: filterClause, layout: ARCHIVE_LAYOUT, order: "CreateTime desc", size: String(PAGE_SIZE), skip: String(skip) });
        const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
        const entities = Array.isArray(payload.entities) ? payload.entities : [];
        return entities.map(normalizeRecord).filter(item => item.id);
    }

    async function loadArchive() {
        if (archiveLoading) return;
        archiveLoading = true;
        archiveCancelled = false;
        archive = [];
        semanticIndex = null;
        selectedIds.clear();
        ui.loadButton.disabled = true;
        ui.cancelLoad.hidden = false;
        ui.search.disabled = true;
        ui.semanticSearch.disabled = true;
        ui.exportButton.disabled = true;
        ui.copyButton.disabled = true;
        const personNote = [
            ui.specialist.dataset.personId ? `Designado Especialista: ${ui.specialist.value}` : "",
            ui.requestedFor.dataset.personId ? `Solicitado para: ${ui.requestedFor.value}` : ""
        ].filter(Boolean).join(" · ");
        setStatus(personNote ? `Medindo o volume (restrito a ${personNote})...` : "Medindo o volume de cada GSE selecionada...", "info");
        setProgress("Consultando totais por GSE...", 2);

        try {
            const groupIds = selectedGseIds();
            if (!groupIds.length) throw new Error("Selecione ao menos um GSE no painel de filtros.");

            let countsDone = 0;
            const perGseUnits = await concurrentMap(groupIds, async id => {
                const label = GSE_NAME[id] || id;
                try {
                    const total = await fetchGseTotalWithRetry(id);
                    countsDone++;
                    setProgress(`Medindo volume: ${countsDone} de ${groupIds.length} GSEs`, 2 + Math.round((countsDone / groupIds.length) * 8));
                    return [{ filterClause: baseGseClause(id), total, label }];
                } catch (error) {
                    if (!isExceededError(error)) throw error;
                    setProgress(`${label} tem mais de 10.000 solicitações — dividindo por período...`, 2 + Math.round((countsDone / groupIds.length) * 8));
                    const units = await splitByDateUntilSafe(id, label, ARCHIVE_EARLIEST_TIME, ARCHIVE_LATEST_TIME, 0);
                    countsDone++;
                    setProgress(`Medindo volume: ${countsDone} de ${groupIds.length} GSEs`, 2 + Math.round((countsDone / groupIds.length) * 8));
                    return units;
                }
            });
            if (archiveCancelled) throw new Error("Carga cancelada.");

            const units = [];
            const failedCounts = [];
            perGseUnits.forEach(entry => {
                if (Array.isArray(entry)) units.push(...entry);
                else if (entry && entry.error) failedCounts.push(entry);
            });

            const batches = planBatches(units);
            const grandTotal = units.reduce((sum, item) => sum + item.total, 0);

            const warnings = [];
            if (failedCounts.length) {
                const details = failedCounts.map(entry => {
                    const name = GSE_NAME[entry.item] || entry.item;
                    const reason = entry.error && entry.error.message ? entry.error.message : "erro desconhecido";
                    return `${name} [${reason}]`;
                }).join("; ");
                warnings.push(`Não foi possível medir (ficaram de fora): ${details}`);
            }
            const oversized = batches.filter(batch => batch.total > BATCH_SAFETY_LIMIT);
            if (oversized.length) {
                warnings.push(`${oversized.length} lote(s) sozinho(s) passam da margem de segurança (${BATCH_SAFETY_LIMIT.toLocaleString("pt-BR")})`);
            }

            setProgress(`Carregando acervo: 0 de ${grandTotal.toLocaleString("pt-BR")} solicitações`, 10);

            const totalPages = batches.reduce((sum, batch) => sum + Math.max(1, Math.ceil(batch.total / PAGE_SIZE)), 0) || 1;
            let pagesDone = 0;
            let loadedCount = 0;
            const failedBatches = [];

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                if (archiveCancelled) break;
                const batch = batches[batchIndex];
                const combinedFilter = combineClauses(batch.clauses);
                const pageCount = Math.max(1, Math.ceil(batch.total / PAGE_SIZE));
                const pageIndexes = Array.from({ length: pageCount }, (_, index) => index * PAGE_SIZE);
                try {
                    const pages = await concurrentMap(pageIndexes, async skip => {
                        const records = await fetchBatchPage(combinedFilter, skip);
                        pagesDone++;
                        loadedCount += records.length;
                        setProgress(`Carregando acervo (lote ${batchIndex + 1} de ${batches.length}): ${loadedCount.toLocaleString("pt-BR")} solicitações`, 10 + Math.round((pagesDone / totalPages) * 88));
                        return records;
                    });
                    pages.forEach(page => { if (Array.isArray(page)) archive.push(...page); });
                } catch (error) {
                    failedBatches.push(batch.labels.join(", "));
                }
            }

            if (archiveCancelled) { setStatus("Carga cancelada pelo usuário.", "warning"); return; }

            const byId = new Map();
            archive.forEach(item => byId.set(item.id, item));
            archive = Array.from(byId.values());
            archiveLoadedAt = new Date();

            setProgress(`Acervo carregado: ${archive.length.toLocaleString("pt-BR")} solicitações`, 100);
            if (failedBatches.length) warnings.push(`Falha ao carregar: ${failedBatches.join(" | ")}`);
            const warningNote = warnings.length ? ` ⚠ ${warnings.join(" · ")}. Clique em "Carregar acervo completo" de novo para tentar reaver o que faltou.` : "";
            setStatus(`Acervo pronto (${archive.length.toLocaleString("pt-BR")} solicitações, ${batches.length} lote(s)) — carregado às ${archiveLoadedAt.toLocaleTimeString("pt-BR")}.${warningNote}`, warnings.length ? "warning" : "success");
            ui.search.disabled = false;
            ui.semanticSearch.disabled = false;
            ui.copyButton.disabled = !archive.length;
            ui.exportButton.disabled = !archive.length;
            renderStats();
        } catch (error) {
            setStatus(error.message || String(error), "error");
        } finally {
            archiveLoading = false;
            ui.loadButton.disabled = false;
            ui.cancelLoad.hidden = true;
        }
    }

    function selectedGseIds() {
        return Array.from(ui.gseList.querySelectorAll("input[data-gse]:checked")).map(input => input.value);
    }

    // ============================================================
    // PESQUISA TEXTUAL (operadores lógicos)
    // ============================================================
    function normalize(value, ignoreCase, ignoreAccents) {
        let text = String(value || "");
        if (ignoreAccents) try { text = text.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (_) {}
        return ignoreCase ? text.toLocaleLowerCase("pt-BR") : text;
    }

    function tokenize(query, defaultJoin) {
        const output = [];
        const regex = /"([^"]*)"|\(|\)|\b(?:AND|OR|NOT|E|OU|NAO|NÃO)\b|-?[^\s()]+/giu;
        let match;
        while ((match = regex.exec(query))) {
            const raw = match[0], upper = raw.toLocaleUpperCase("pt-BR");
            if (match[1] != null) output.push({ type: "TERM", value: match[1] });
            else if (raw === "(" || raw === ")") output.push({ type: raw });
            else if (["AND", "E"].includes(upper)) output.push({ type: "AND" });
            else if (["OR", "OU"].includes(upper)) output.push({ type: "OR" });
            else if (["NOT", "NAO", "NÃO"].includes(upper)) output.push({ type: "NOT" });
            else if (raw.startsWith("-") && raw.length > 1) output.push({ type: "NOT" }, { type: "TERM", value: raw.slice(1) });
            else output.push({ type: "TERM", value: raw });
        }
        const withDefault = [];
        for (const token of output) {
            const previous = withDefault[withDefault.length - 1];
            if (previous && ["TERM", ")"].includes(previous.type) && ["TERM", "(", "NOT"].includes(token.type)) withDefault.push({ type: defaultJoin });
            withDefault.push(token);
        }
        return withDefault;
    }

    function toRpn(tokens) {
        const output = [], stack = [], priority = { OR: 1, AND: 2, NOT: 3 };
        for (const token of tokens) {
            if (token.type === "TERM") output.push(token);
            else if (token.type === "(") stack.push(token);
            else if (token.type === ")") {
                while (stack.length && stack[stack.length - 1].type !== "(") output.push(stack.pop());
                if (!stack.length) throw new Error("Parênteses não balanceados.");
                stack.pop();
            } else {
                while (stack.length && stack[stack.length - 1].type !== "(" && priority[stack[stack.length - 1].type] >= priority[token.type]) output.push(stack.pop());
                stack.push(token);
            }
        }
        while (stack.length) {
            const token = stack.pop();
            if (token.type === "(") throw new Error("Parênteses não balanceados.");
            output.push(token);
        }
        return output;
    }

    function compileMatcher(query, mode, ignoreCase, ignoreAccents) {
        const normalized = normalize(query.trim(), ignoreCase, ignoreAccents);
        if (!normalized) throw new Error("Digite um termo ou expressão de pesquisa.");
        if (mode === "exact") return text => text.includes(normalized);
        const expression = toRpn(tokenize(query, "OR").map(token => token.type === "TERM" ? Object.assign({}, token, { value: normalize(token.value, ignoreCase, ignoreAccents) }) : token));
        return text => {
            const stack = [];
            for (const token of expression) {
                if (token.type === "TERM") stack.push(text.includes(token.value));
                else if (token.type === "NOT") stack.push(!stack.pop());
                else { const right = stack.pop(), left = stack.pop(); stack.push(token.type === "AND" ? left && right : left || right); }
            }
            if (stack.length !== 1) throw new Error("Expressão lógica inválida.");
            return stack[0];
        };
    }

    // termos "positivos" da consulta (ignora NÃO/operadores), usados só pra
    // destacar visualmente onde o termo aparece dentro do texto do resultado.
    function extractHighlightTerms(query, mode) {
        if (mode === "exact") {
            const phrase = query.trim().replace(/^"|"$/g, "");
            return phrase ? [phrase] : [];
        }
        const tokens = tokenize(query, "OR");
        const terms = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type === "TERM" && tokens[i - 1] && tokens[i - 1].type === "NOT") continue;
            if (tokens[i].type === "TERM") terms.push(tokens[i].value);
        }
        return Array.from(new Set(terms.filter(Boolean)));
    }

    // ============================================================
    // FILTROS AVANÇADOS (pessoas + data)
    // ============================================================
    function parseDateInput(value, endOfDay) {
        if (!value) return null;
        const parts = value.split("-").map(Number);
        if (parts.length !== 3) return null;
        return new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
    }

    function personMatches(actual, expected, ignoreCase, ignoreAccents) {
        if (!expected.trim()) return true;
        return normalize(actual, ignoreCase, ignoreAccents).includes(normalize(expected.trim(), ignoreCase, ignoreAccents));
    }

    function advancedFiltersMatch(item) {
        const ignoreCase = ui.ignoreCase.checked;
        const ignoreAccents = ui.ignoreAccents.checked;
        if (!personMatches(item.requestedFor, ui.requestedFor.value, ignoreCase, ignoreAccents)) return false;
        if (!personMatches(item.assignedSpecialist, ui.specialist.value, ignoreCase, ignoreAccents)) return false;
        if (ui.vipOnly.checked && !item.isVip) return false;
        const mode = ui.dateMode.value;
        if (mode === "any") return true;
        const created = Number(item.created);
        if (!Number.isFinite(created)) return false;
        const from = parseDateInput(ui.dateFrom.value, false);
        const to = parseDateInput(ui.dateTo.value, true);
        if (mode === "on") return from != null && created >= from && created <= parseDateInput(ui.dateFrom.value, true);
        if (mode === "after") return from != null && created >= from;
        if (mode === "before") return to != null && created <= to;
        if (mode === "between") return from != null && to != null && created >= from && created <= to;
        return true;
    }

    function updateDateControls() {
        const mode = ui.dateMode.value;
        ui.dateFromWrap.hidden = !["on", "after", "between"].includes(mode);
        ui.dateToWrap.hidden = !["before", "between"].includes(mode);
        ui.dateFromLabel.textContent = mode === "between" ? "Data inicial" : mode === "after" ? "A partir de" : "Data";
        ui.dateToLabel.textContent = mode === "between" ? "Data final" : "Até";
    }

    function insertOperator(value) {
        const input = ui.query, start = input.selectionStart == null ? input.value.length : input.selectionStart, end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
        if (value === '""') { input.value = input.value.slice(0, start) + '"' + input.value.slice(start, end) + '"' + input.value.slice(end); input.setSelectionRange(start + 1, end + 1); }
        else if (value === "()") { input.value = input.value.slice(0, start) + "(" + input.value.slice(start, end) + ")" + input.value.slice(end); input.setSelectionRange(start + 1, end + 1); }
        else { input.value = input.value.slice(0, start) + value + input.value.slice(end); input.setSelectionRange(start + value.length, start + value.length); }
        input.focus();
    }

    // ============================================================
    // AUTOCOMPLETE DE PESSOA (Solicitado para / Designado Especialista)
    // Ao escolher uma sugestão, resolve o ID exato da pessoa — usado tanto
    // para restringir o carregamento no servidor (personConstraintClause)
    // quanto continua funcionando como filtro de texto pós-carga se digitado
    // livremente sem selecionar nada da lista.
    // ============================================================
    function installPersonAutocomplete(input, shadow) {
        const MIN_CHARS = 2;
        const DEBOUNCE_MS = 320;
        const control = input.closest(".control");
        const hint = control.querySelector(".person-hint");
        const originalHint = hint ? hint.textContent : "";
        const menu = document.createElement("div");
        menu.className = "specialist-menu";
        menu.hidden = true;
        control.appendChild(menu);

        let timer = null, controller = null, options = [], active = -1, sequence = 0;

        function showMessage(html) {
            menu.innerHTML = `<div class="specialist-message">${html}</div>`;
            menu.hidden = false;
            options = [];
            active = -1;
        }
        function closeMenu() { menu.hidden = true; active = -1; }

        function render(persons) {
            options = persons;
            active = persons.length ? 0 : -1;
            if (!persons.length) { showMessage("Nenhuma pessoa localizada nos GSEs selecionados."); return; }
            menu.innerHTML = "";
            persons.forEach((person, index) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "specialist-option" + (index === active ? " active" : "");
                button.dataset.index = String(index);
                const strong = document.createElement("strong");
                strong.textContent = person.name;
                const small = document.createElement("small");
                small.textContent = person.upn ? "@" + person.upn : "";
                const detail = document.createElement("span");
                detail.textContent = [person.email, person.employeeNumber ? "Matrícula " + person.employeeNumber : ""].filter(Boolean).join(" · ");
                button.append(strong, small, detail);
                button.addEventListener("mousedown", event => { event.preventDefault(); choose(index); });
                menu.appendChild(button);
            });
            menu.hidden = false;
        }

        function updateActive(next) {
            if (!options.length) return;
            active = (next + options.length) % options.length;
            menu.querySelectorAll(".specialist-option").forEach((button, index) => button.classList.toggle("active", index === active));
            const activeEl = menu.querySelector(`[data-index="${active}"]`);
            if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
        }

        function choose(index) {
            const person = options[index];
            if (!person) return;
            input.value = person.name;
            input.dataset.personId = person.id;
            if (hint) { hint.textContent = `✓ ${person.name} selecionado(a) — carregamento será restrito a essa pessoa`; hint.classList.add("confirmed"); }
            closeMenu();
            input.focus();
        }

        async function searchPersons(query) {
            const groups = selectedGseIds();
            if (!groups.length) { showMessage("Selecione ao menos um GSE primeiro."); return; }
            if (controller) controller.abort();
            controller = new AbortController();
            const current = ++sequence;
            showMessage('<span class="specialist-spinner"></span>Consultando pessoas no SMAX...');

            const groupExpression = `PersonToGroup[Id in (${groups.join(",")})]`;
            const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
            const nameClauses = words.map(word => `(PersonalDetails wordstartswith ('${word.replace(/'/g, "''")}'))`).join(" and ");
            const filter = `((${groupExpression}) and (${nameClauses}))`;
            const params = new URLSearchParams({
                filter, layout: "Name,Upn,IsDeleted,Email,EmployeeNumber", meta: "totalCount", order: "Name asc", size: "30"
            });

            try {
                const payload = await fetchJson(`${getRestBase()}/ems/Person?${params}`, { signal: controller.signal });
                if (current !== sequence) return;
                const byId = new Map();
                (Array.isArray(payload.entities) ? payload.entities : []).forEach(entity => {
                    const p = entity.properties || {};
                    const person = {
                        id: String(p.Id || ""), name: String(p.Name || "").trim(),
                        upn: String(p.Upn || "").trim(), email: String(p.Email || "").trim(),
                        employeeNumber: String(p.EmployeeNumber || "").trim()
                    };
                    if (person.id && person.name && !byId.has(person.id)) byId.set(person.id, person);
                });
                render(Array.from(byId.values()));
            } catch (error) {
                if (error.name === "AbortError") return;
                showMessage("Não foi possível consultar pessoas: " + String(error.message || error));
            }
        }

        input.addEventListener("input", () => {
            delete input.dataset.personId;
            if (hint) { hint.textContent = originalHint; hint.classList.remove("confirmed"); }
            clearTimeout(timer);
            const query = input.value.trim();
            if (query.length < MIN_CHARS) { closeMenu(); return; }
            timer = setTimeout(() => searchPersons(query), DEBOUNCE_MS);
        });
        input.addEventListener("keydown", event => {
            if (menu.hidden) return;
            if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); updateActive(active + 1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); updateActive(active - 1); }
            else if (event.key === "Enter") { if (active >= 0) { event.preventDefault(); event.stopPropagation(); choose(active); } }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
        });
        input.addEventListener("focus", () => { if (options.length && input.value.trim().length >= MIN_CHARS) menu.hidden = false; });
        shadow.addEventListener("mousedown", event => { if (!event.composedPath().includes(control)) closeMenu(); });
        shadow.querySelectorAll(".gse-list input[data-gse]").forEach(checkbox => {
            checkbox.addEventListener("change", () => {
                options = []; closeMenu();
                delete input.dataset.personId;
                if (hint) { hint.textContent = originalHint; hint.classList.remove("confirmed"); }
            });
        });
    }

    // ============================================================
    // BUSCA POR SEMELHANÇA (BM25) — 100% local, sem chamada de rede/IA.
    // Compara o texto colado (descrição do chamado atual) com cada
    // solicitação já carregada em memória, usando o mesmo tipo de algoritmo
    // de ranking por relevância usado por buscadores de texto como o
    // Elasticsearch. Nada sai do navegador nessa etapa.
    // ============================================================
    // Stemmer leve (não é o RSLP completo): normaliza plural simples e
    // advérbios em "-mente" pra aumentar recall sem arriscar juntar palavras
    // sem relação nenhuma entre si.
    function stemLight(token) {
        if (token.length > 4 && token.endsWith("mente")) return token.slice(0, -5);
        if (token.length > 4 && (token.endsWith("ões") || token.endsWith("ãos"))) return token.slice(0, -3) + "ao";
        if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
        return token;
    }

    function tokenizeForIndex(rawText) {
        const normalized = normalize(rawText, true, true);
        const matches = normalized.match(/[a-z0-9]+/g) || [];
        const out = [];
        for (const token of matches) {
            if (token.length < SEMANTIC_MIN_TOKEN_LEN || STOPWORDS_PT.has(token)) continue;
            out.push(stemLight(token));
        }
        return out;
    }

    // Índice invertido: termo -> Map(índice do chamado no acervo -> frequência).
    // Construído sob demanda (uma vez por carga do acervo, na primeira busca
    // por semelhança) — evita gastar tempo indexando se o recurso não for usado.
    function buildSemanticIndex() {
        const postings = new Map();
        const docLen = new Array(archive.length);
        let totalLen = 0;
        for (let idx = 0; idx < archive.length; idx++) {
            const item = archive[idx];
            const terms = tokenizeForIndex(`${item.description} ${item.solution}`);
            docLen[idx] = terms.length;
            totalLen += terms.length;
            const tf = new Map();
            for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
            tf.forEach((count, term) => {
                let bucket = postings.get(term);
                if (!bucket) { bucket = new Map(); postings.set(term, bucket); }
                bucket.set(idx, count);
            });
        }
        semanticIndex = { postings, docLen, avgDocLen: totalLen / (archive.length || 1), N: archive.length, builtForLength: archive.length };
    }

    function ensureSemanticIndex() {
        if (!semanticIndex || semanticIndex.builtForLength !== archive.length) buildSemanticIndex();
    }

    // BM25: pondera termos raros no acervo (IDF alto) mais que termos comuns,
    // e normaliza pelo tamanho de cada chamado (chamados muito longos não
    // vencem só por terem mais palavras). Piso no IDF evita score negativo
    // para termos muito comuns que escaparam da lista de stopwords.
    function computeBm25Scores(queryTerms) {
        const { postings, docLen, avgDocLen, N } = semanticIndex;
        const scores = new Map();
        const termWeights = new Map();
        Array.from(new Set(queryTerms)).forEach(term => {
            const bucket = postings.get(term);
            if (!bucket) return;
            const df = bucket.size;
            const idf = Math.max(0.01, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
            termWeights.set(term, idf);
            bucket.forEach((tf, idx) => {
                const dl = docLen[idx] || 0;
                const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (avgDocLen || 1)));
                scores.set(idx, (scores.get(idx) || 0) + idf * (tf * (BM25_K1 + 1)) / (denom || 1));
            });
        });
        return { scores, termWeights };
    }

    // Adia o trabalho pesado um tick (setTimeout 0) só pra garantir que a
    // mensagem "Indexando..." pinte na tela antes do cálculo síncrono travar
    // a thread por um instante em acervos muito grandes.
    function performSemanticSearch() {
        if (!archive.length) { setStatus("Carregue o acervo completo antes de buscar por semelhança.", "warning"); return; }
        const text = ui.semanticQuery.value.trim();
        if (!text) { setStatus("Cole a descrição do chamado atual no campo de busca por semelhança.", "warning"); return; }
        setStatus("Indexando o acervo para busca por semelhança (só na primeira busca após carregar)...", "info");
        ui.semanticSearch.disabled = true;
        setTimeout(() => {
            try { runSemanticSearch(text); }
            finally { ui.semanticSearch.disabled = false; }
        }, 20);
    }

    function runSemanticSearch(text) {
        searchMode = "semantic";
        ensureSemanticIndex();
        const queryTerms = tokenizeForIndex(text);
        if (!queryTerms.length) { setStatus("Não encontramos termos relevantes nesse texto (tente descrever com mais detalhes).", "warning"); return; }
        const { scores, termWeights } = computeBm25Scores(queryTerms);
        const limit = Number(ui.semanticLimit.value) || SEMANTIC_DEFAULT_LIMIT;
        const ranked = Array.from(scores.entries())
            .map(([idx, score]) => ({ item: archive[idx], score }))
            .filter(entry => entry.item && advancedFiltersMatch(entry.item))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        lastQueryTerms = Array.from(termWeights.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term]) => term);
        semanticScores = new Map(ranked.map(entry => [entry.item.id, entry.score]));
        semanticMaxScore = ranked.length ? ranked[0].score : 1;
        results = ranked.map(entry => entry.item);
        currentPage = 1;
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        sortMode = "similarity";
        ui.sortSelect.value = "similarity";
        activeIndex = results.length ? 0 : -1;
        renderResults();
        setStatus(results.length
            ? `${results.length.toLocaleString("pt-BR")} caso(s) semelhante(s) encontrado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas — busca 100% local, nada enviado pra fora.`
            : "Nenhum caso semelhante encontrado (tente descrever com outras palavras).", results.length ? "success" : "warning");
    }

    function performSearch() {
        try {
            searchMode = "terms";
            const query = ui.query.value;
            const field = ui.field.value;
            const mode = ui.mode.value;
            const ignoreCase = ui.ignoreCase.checked;
            const ignoreAccents = ui.ignoreAccents.checked;
            const matcher = compileMatcher(query, mode, ignoreCase, ignoreAccents);
            lastQueryTerms = extractHighlightTerms(query, mode);
            results = archive.filter(item => {
                const description = normalize(item.description, ignoreCase, ignoreAccents);
                const solution = normalize(item.solution, ignoreCase, ignoreAccents);
                const textMatch = field === "description" ? matcher(description) : field === "solution" ? matcher(solution) : matcher(description) || matcher(solution);
                return textMatch && advancedFiltersMatch(item);
            });
            currentPage = 1;
            focusedIndex = -1;
            if (ui.focusOverlay) ui.focusOverlay.hidden = true;
            applySort();
            activeIndex = results.length ? 0 : -1;
            renderResults();
            setStatus(`${results.length.toLocaleString("pt-BR")} resultado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas.`, results.length ? "success" : "warning");
        } catch (error) {
            setStatus(error.message || String(error), "error");
        }
    }

    function countOccurrences(item) {
        if (!lastQueryTerms.length) return 0;
        const ignoreCase = ui.ignoreCase.checked, ignoreAccents = ui.ignoreAccents.checked;
        const text = normalize(`${item.description} ${item.solution}`, ignoreCase, ignoreAccents);
        return lastQueryTerms.reduce((sum, term) => {
            const needle = normalize(term, ignoreCase, ignoreAccents);
            if (!needle) return sum;
            return sum + text.split(needle).length - 1;
        }, 0);
    }

    function applySort() {
        if (sortMode === "recent") results.sort((a, b) => Number(b.created) - Number(a.created));
        else if (sortMode === "oldest") results.sort((a, b) => Number(a.created) - Number(b.created));
        else if (sortMode === "relevance") results.sort((a, b) => countOccurrences(b) - countOccurrences(a));
        else if (sortMode === "similarity") results.sort((a, b) => (semanticScores.get(b.id) || 0) - (semanticScores.get(a.id) || 0));
    }

    // ============================================================
    // ESTATÍSTICAS DO ACERVO CARREGADO
    // ============================================================
    function renderStats() {
        if (!archive.length) { ui.statsStrip.hidden = true; return; }
        ui.statsStrip.hidden = false;
        const byGse = new Map();
        let newest = -Infinity, oldest = Infinity;
        archive.forEach(item => {
            byGse.set(item.groupName, (byGse.get(item.groupName) || 0) + 1);
            const created = Number(item.created);
            if (Number.isFinite(created)) { if (created > newest) newest = created; if (created < oldest) oldest = created; }
        });
        const ranked = Array.from(byGse.entries()).sort((a, b) => b[1] - a[1]);
        const maxCount = ranked.length ? ranked[0][1] : 1;
        ui.statsCount.textContent = `${archive.length.toLocaleString("pt-BR")} solicitações`;
        ui.statsLoadedAt.textContent = archiveLoadedAt ? `carregado às ${archiveLoadedAt.toLocaleTimeString("pt-BR")}` : "";
        ui.statsRange.textContent = Number.isFinite(oldest) && Number.isFinite(newest)
            ? `de ${formatDate(oldest)} até ${formatDate(newest)}`
            : "";
        ui.statsGseList.innerHTML = ranked.map(([name, count]) => `
            <div class="gse-bar-row">
                <span class="gse-bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <div class="gse-bar-track"><div class="gse-bar-fill" style="width:${Math.max(4, Math.round((count / maxCount) * 100))}%"></div></div>
                <span class="gse-bar-count">${count.toLocaleString("pt-BR")}</span>
            </div>`).join("");
    }

    // ============================================================
    // SELEÇÃO (checklist persistente entre páginas e buscas)
    // ============================================================
    function isSelected(id) { return selectedIds.has(id); }

    function setSelection(id, checked) {
        if (checked) selectedIds.add(id); else selectedIds.delete(id);
        updateSelectionUi();
    }

    function selectPage() {
        const start = (currentPage - 1) * PAGE_RESULTS;
        results.slice(start, start + PAGE_RESULTS).forEach(item => selectedIds.add(item.id));
        updateSelectionUi();
        renderResults();
    }

    function selectAllResults() {
        results.forEach(item => selectedIds.add(item.id));
        updateSelectionUi();
        renderResults();
    }

    function clearSelection() {
        selectedIds.clear();
        updateSelectionUi();
        renderResults();
        if (focusedIndex >= 0) openFocus(focusedIndex);
    }

    function updateSelectionUi() {
        const count = selectedIds.size;
        ui.selectionCount.textContent = count ? `${count.toLocaleString("pt-BR")} selecionada(s)` : "";
        ui.clearSelectionButton.hidden = !count;
        ui.openSelectedButton.disabled = !count;
    }

    function openSelectedInTabs() {
        const ids = Array.from(selectedIds);
        if (!ids.length) return;
        ids.slice(0, OPEN_SELECTED_CAP).forEach(id => window.open(`${location.origin}/saw/Request/${encodeURIComponent(id)}/general`, "_blank"));
        setStatus(ids.length > OPEN_SELECTED_CAP
            ? `Abertas as primeiras ${OPEN_SELECTED_CAP} de ${ids.length} selecionadas (limite de segurança contra bloqueio de pop-up).`
            : `${ids.length} chamado(s) aberto(s) em novas abas.`, "success");
    }

    // ============================================================
    // EXPORTAÇÃO (CSV / JSON / TXT / HTML) — respeita a seleção, se houver
    // ============================================================
    function exportRows() {
        if (selectedIds.size) return archive.filter(item => selectedIds.has(item.id));
        return results.length ? results : archive;
    }

    function downloadFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime + ";charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function csvEscape(value) {
        const text = String(value == null ? "" : value);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    function exportCsv() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const header = ["ID", "Data de criação", "Solicitado para", "VIP", "Designado Especialista", "GSE", "Descrição", "Solução"];
        const lines = [header.map(csvEscape).join(",")];
        rows.forEach(item => {
            lines.push([item.id, formatDate(item.created), item.requestedFor, item.isVip ? "Sim" : "Não", item.assignedSpecialist, item.groupName, item.description, item.solution].map(csvEscape).join(","));
        });
        downloadFile(`acervo-smax-${timestamp()}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em CSV.`, "success");
    }

    function exportJson() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        downloadFile(`acervo-smax-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em JSON.`, "success");
    }

    function exportTxt() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const parts = rows.map(item => [
            `Chamado: ${item.id}${item.isVip ? "  [VIP]" : ""}`,
            `Data de criação: ${formatDate(item.created)}`,
            `Solicitado para: ${item.requestedFor}`,
            `Designado Especialista: ${item.assignedSpecialist}`,
            `GSE: ${item.groupName}`,
            `Descrição: ${item.description || "Não informado"}`,
            `Solução: ${item.solution || "Não informado"}`,
            "-".repeat(60)
        ].join("\n"));
        downloadFile(`acervo-smax-${timestamp()}.txt`, parts.join("\n\n"), "text/plain");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em TXT.`, "success");
    }

    function exportHtml() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const cards = rows.map(item => `
            <article style="border:1px solid #d5e0ea;border-left:4px solid #1a73c7;border-radius:8px;padding:14px 16px;margin-bottom:14px;background:#fff">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <a href="${escapeHtml(location.origin)}/saw/Request/${encodeURIComponent(item.id)}/general" style="color:#12558f;font-weight:800;text-decoration:none;font-size:15px">${escapeHtml(item.id)}</a>
                    ${item.isVip ? '<span style="font-size:10px;font-weight:800;color:#8a6300;background:#ffe9a8;border-radius:4px;padding:2px 7px">⭐ VIP</span>' : ""}
                    <span style="margin-left:auto;font-size:11px;color:#7a8b9b">${escapeHtml(formatDate(item.created))}</span>
                </div>
                <div style="margin-bottom:8px"><strong style="display:block;font-size:10.5px;text-transform:uppercase;color:#12558f;margin-bottom:3px">Descrição</strong><p style="margin:0;white-space:pre-wrap">${escapeHtml(item.description || "Não informado")}</p></div>
                <div><strong style="display:block;font-size:10.5px;text-transform:uppercase;color:#12558f;margin-bottom:3px">Solução</strong><p style="margin:0;white-space:pre-wrap">${escapeHtml(item.solution || "Não informado")}</p></div>
                <footer style="display:flex;gap:16px;margin-top:10px;padding-top:8px;border-top:1px solid #eef2f6;font-size:11.5px;color:#526477">
                    <span>Solicitado para: ${escapeHtml(item.requestedFor)}</span><span>Especialista: ${escapeHtml(item.assignedSpecialist)}</span><span>${escapeHtml(item.groupName)}</span>
                </footer>
            </article>`).join("");
        const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Acervo SMAX — Exportação</title></head>
            <body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f2f5f8;color:#273746;margin:0;padding:28px">
                <h1 style="color:#12558f;margin:0 0 4px">Pesquisa no Acervo SMAX</h1>
                <p style="color:#526477;margin:0 0 20px">Exportado em ${escapeHtml(new Date().toLocaleString("pt-BR"))} · ${rows.length.toLocaleString("pt-BR")} solicitação(ões) · Imprima esta página (Ctrl+P) para gerar um PDF.</p>
                ${cards}
            </body></html>`;
        downloadFile(`acervo-smax-${timestamp()}.html`, html, "text/html");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em HTML (abra e use Ctrl+P para PDF).`, "success");
    }

    async function copySummary() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para copiar ainda.", "warning");
        const text = rows.map(item => `${item.id}${item.isVip ? " [VIP]" : ""} — ${item.requestedFor} — ${formatDate(item.created)} — ${item.groupName}`).join("\n");
        try {
            await navigator.clipboard.writeText(text);
            setStatus(`Resumo de ${rows.length.toLocaleString("pt-BR")} solicitação(ões) copiado para a área de transferência.`, "success");
        } catch (_) {
            setStatus("Não foi possível acessar a área de transferência do navegador.", "error");
        }
    }

    async function copyOne(item) {
        try {
            await navigator.clipboard.writeText(`${item.id}${item.isVip ? " [VIP]" : ""} — ${item.requestedFor} — ${formatDate(item.created)} — ${item.groupName}`);
            setStatus(`Resumo de ${item.id} copiado.`, "success");
        } catch (_) {
            setStatus("Não foi possível acessar a área de transferência do navegador.", "error");
        }
    }

    function timestamp() {
        const now = new Date();
        const pad = n => String(n).padStart(2, "0");
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    }

    // ============================================================
    // FORMATAÇÃO / DESTAQUE
    // ============================================================
    function setStatus(message, type) { ui.status.textContent = message || ""; ui.status.className = "status " + (type || ""); }
    function setProgress(message, percent) { ui.progressText.textContent = message; ui.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; ui.progress.hidden = false; }

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    // A busca por semelhança guarda os termos já sem acento (pro índice
    // BM25); pra destacar corretamente no texto original (que tem acento),
    // cada letra vira uma classe de caracteres aceitando as variantes
    // acentuadas — assim "cartorio" ainda encontra e marca "cartório".
    const HIGHLIGHT_ACCENT_CLASS = { a: "aàáâã", e: "eèéê", i: "iìí", o: "oòóôõ", u: "uùú", c: "cç" };
    function accentInsensitivePattern(term) {
        return term.split("").map(ch => {
            const variant = HIGHLIGHT_ACCENT_CLASS[ch.toLocaleLowerCase("pt-BR")];
            return variant ? `[${variant}${variant.toLocaleUpperCase("pt-BR")}]` : escapeRegExp(ch);
        }).join("");
    }

    function highlight(text) {
        const escaped = escapeHtml(text || "Não informado");
        if (!lastQueryTerms.length) return escaped;
        const pattern = lastQueryTerms.map(term => accentInsensitivePattern(escapeHtml(term))).filter(Boolean).join("|");
        if (!pattern) return escaped;
        try { return escaped.replace(new RegExp(`(${pattern})`, "giu"), "<mark>$1</mark>"); } catch (_) { return escaped; }
    }

    function formatDate(value) {
        if (!value) return "Não informada";
        const number = Number(value), date = Number.isFinite(number) ? new Date(number) : new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("pt-BR");
    }

    function contentBlock(label, text) {
        const long = String(text || "").length > 650;
        return `<div class="field${long ? " collapsed" : ""}"><strong>${label}</strong><p>${highlight(text)}</p>${long ? '<button class="expand-text" type="button">Mostrar mais</button>' : ""}</div>`;
    }

    // ============================================================
    // NAVEGADOR ENTRE RESULTADOS + MODO EXPANDIDO
    // ============================================================
    function updateNavigator() {
        const valid = activeIndex >= 0 && activeIndex < results.length;
        ui.previousResult.disabled = !valid || activeIndex === 0;
        ui.nextResult.disabled = !valid || activeIndex === results.length - 1;
        ui.focusResult.disabled = !valid;
        ui.resultCounter.textContent = valid ? `${activeIndex + 1} de ${results.length}` : (results.length ? "" : "Nenhum resultado");
    }

    function activateResult(index, scroll) {
        if (!results.length) return;
        activeIndex = Math.max(0, Math.min(index, results.length - 1));
        const neededPage = Math.floor(activeIndex / PAGE_RESULTS) + 1;
        if (neededPage !== currentPage) { currentPage = neededPage; renderResults(); }
        else {
            ui.results.querySelectorAll(".result-card").forEach(card => card.classList.toggle("active", Number(card.dataset.index) === activeIndex));
            updateNavigator();
        }
        if (scroll) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const card = ui.results.querySelector(`.result-card[data-index="${activeIndex}"]`);
                if (card) ui.results.scrollTo({ top: Math.max(0, card.offsetTop - ui.results.offsetTop - 10), behavior: "smooth" });
            }));
        }
    }

    function moveResult(delta) {
        if (!results.length) return;
        activateResult(activeIndex < 0 ? 0 : activeIndex + delta, true);
        if (focusedIndex >= 0) openFocus(activeIndex);
    }

    function openFocus(index) {
        if (!results[index]) return;
        activeIndex = index;
        focusedIndex = index;
        const item = results[index];
        const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
        ui.focusBody.innerHTML = `
            <header class="focus-header">
                <div>
                    <span class="focus-position">Chamado ${index + 1} de ${results.length}${item.isVip ? " · ⭐ VIP" : ""}</span>
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.id)}</a>
                    <small>Criado em ${escapeHtml(formatDate(item.created))} · ${escapeHtml(item.groupName)}</small>
                </div>
                <label class="focus-select"><input type="checkbox" class="focus-checkbox" ${isSelected(item.id) ? "checked" : ""}>Selecionar</label>
                <button class="focus-close" type="button">×</button>
            </header>
            <nav class="focus-nav">
                <button class="focus-prev" type="button" ${index === 0 ? "disabled" : ""}>Anterior</button>
                <span>${index + 1} de ${results.length}</span>
                <button class="focus-next" type="button" ${index === results.length - 1 ? "disabled" : ""}>Próximo</button>
                <small>Use ↑ e ↓ para navegar</small>
            </nav>
            <div class="focus-scroll">
                <section><h3>Descrição</h3><div>${highlight(item.description)}</div></section>
                <section><h3>Solução</h3><div>${highlight(item.solution)}</div></section>
                <footer>
                    <div><small>Solicitado para</small><strong>${escapeHtml(item.requestedFor)}</strong></div>
                    <div><small>Designado Especialista</small><strong>${escapeHtml(item.assignedSpecialist)}</strong></div>
                    <div><small>GSE</small><strong>${escapeHtml(item.groupName)}</strong></div>
                </footer>
            </div>`;
        ui.focusBody.querySelector(".focus-close").addEventListener("click", closeFocus);
        ui.focusBody.querySelector(".focus-prev").addEventListener("click", () => { if (activeIndex > 0) { activateResult(activeIndex - 1, false); openFocus(activeIndex); } });
        ui.focusBody.querySelector(".focus-next").addEventListener("click", () => { if (activeIndex < results.length - 1) { activateResult(activeIndex + 1, false); openFocus(activeIndex); } });
        ui.focusBody.querySelector(".focus-checkbox").addEventListener("change", event => setSelection(item.id, event.target.checked));
        ui.focusOverlay.hidden = false;
        const scroller = ui.focusBody.querySelector(".focus-scroll");
        if (scroller) scroller.scrollTop = 0;
        updateNavigator();
    }

    function closeFocus() {
        focusedIndex = -1;
        if (ui && ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
    }

    // ============================================================
    // RENDERIZAÇÃO DE RESULTADOS
    // ============================================================
    function renderResults() {
        ui.results.innerHTML = "";
        if (!results.length) {
            ui.results.innerHTML = '<div class="empty">Nenhuma solicitação corresponde aos critérios (ou o acervo ainda não foi carregado).</div>';
            ui.pagination.hidden = true;
            updateNavigator();
            return;
        }
        const pages = Math.ceil(results.length / PAGE_RESULTS);
        currentPage = Math.max(1, Math.min(currentPage, pages));
        const start = (currentPage - 1) * PAGE_RESULTS;
        const fragment = document.createDocumentFragment();
        results.slice(start, start + PAGE_RESULTS).forEach((item, localIndex) => {
            const globalIndex = start + localIndex;
            const isSemanticResult = searchMode === "semantic" && semanticScores.has(item.id);
            const similarityPct = isSemanticResult ? Math.round((semanticScores.get(item.id) / (semanticMaxScore || 1)) * 100) : 0;
            const occurrences = !isSemanticResult && lastQueryTerms.length ? countOccurrences(item) : 0;
            const card = document.createElement("article");
            card.className = "result-card" + (item.isVip ? " vip" : "") + (globalIndex === activeIndex ? " active" : "");
            card.dataset.index = String(globalIndex);
            const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
            card.innerHTML = `<header>
                    <label class="select-checkbox" title="Selecionar para exportação"><input type="checkbox" class="row-select" ${isSelected(item.id) ? "checked" : ""}></label>
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.25"></circle><path d="M15.2 15.2L20 20"></path></svg>${escapeHtml(item.id)}</a>
                    ${item.isVip ? '<span class="vip-badge">⭐ VIP</span>' : ""}
                    <span class="gse-tag">${escapeHtml(item.groupName)}</span>
                    ${isSemanticResult ? `<span class="sim-badge">${similarityPct}% semelhante</span>` : (occurrences ? `<span class="occ-badge">${occurrences}×</span>` : "")}
                    <span class="date">${escapeHtml(formatDate(item.created))}</span>
                    <button class="icon-btn copy-one" type="button" title="Copiar resumo"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg></button>
                    <button class="icon-btn expand-one" type="button" title="Expandir"><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg></button>
                </header>
                ${contentBlock("Descrição", item.description)}
                ${contentBlock("Solução", item.solution)}
                <footer><span><small>Solicitado para</small>${escapeHtml(item.requestedFor)}</span><span><small>Designado Especialista</small>${escapeHtml(item.assignedSpecialist)}</span></footer>`;

            card.querySelector(".row-select").addEventListener("click", event => event.stopPropagation());
            card.querySelector(".row-select").addEventListener("change", event => setSelection(item.id, event.target.checked));
            card.querySelector(".expand-one").addEventListener("click", event => { event.stopPropagation(); activateResult(globalIndex, false); openFocus(globalIndex); });
            card.querySelector(".copy-one").addEventListener("click", event => { event.stopPropagation(); copyOne(item); });
            card.querySelectorAll(".expand-text").forEach(button => button.addEventListener("click", event => {
                event.stopPropagation();
                const field = button.closest(".field");
                field.classList.toggle("collapsed");
                button.textContent = field.classList.contains("collapsed") ? "Mostrar mais" : "Recolher";
            }));
            card.addEventListener("click", event => { if (!event.target.closest("a,button,input,label")) activateResult(globalIndex, false); });

            fragment.appendChild(card);
        });
        ui.results.appendChild(fragment);
        ui.pagination.hidden = pages <= 1;
        ui.pageInfo.textContent = `Página ${currentPage} de ${pages} · ${results.length.toLocaleString("pt-BR")} resultado(s)`;
        ui.prevPage.disabled = currentPage === 1;
        ui.nextPage.disabled = currentPage === pages;
        updateNavigator();
    }

    function buildGseList() {
        ui.gseList.innerHTML = GSES.map(([id, name]) => `<label class="gse-item"><input type="checkbox" data-gse value="${id}" checked><span>${escapeHtml(name)}</span></label>`).join("");
    }

    // ============================================================
    // INTERFACE
    // ============================================================
    function buildUi() {
        host = document.createElement("div");
        host.id = "tjsp-archive-full-host";
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>
            :host {
                all: initial;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                color: #273746; -webkit-font-smoothing: antialiased;
            }
            * { box-sizing: border-box; }
            button, input, select { font: inherit; }

            .launcher {
                position: fixed; right: 24px; top: 140px; z-index: 2147483000;
                width: 48px; height: 48px; border-radius: 50%; border: 2px solid #fff;
                background: linear-gradient(135deg, #1a73c7 0%, #12558f 100%); color: #fff;
                box-shadow: 0 4px 14px rgba(0,0,0,.3); cursor: pointer;
                display: flex; align-items: center; justify-content: center; transition: transform .15s, box-shadow .15s;
            }
            .launcher::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; border: 2px solid #1a73c7; opacity: .6; animation: tjspArchivePulso 2.2s ease-out infinite; pointer-events: none; }
            @keyframes tjspArchivePulso { 0% { transform: scale(.85); opacity: .6; } 100% { transform: scale(1.35); opacity: 0; } }
            .launcher svg { width: 20px; height: 20px; position: relative; fill: none; stroke: currentColor; stroke-width: 2; }
            .launcher:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,0,0,.4); }

            .overlay { position: fixed; inset: 0; z-index: 2147483001; padding: 10px; background: rgba(8,14,22,.6); backdrop-filter: blur(2px); display: none; }
            :host(.open) .overlay { display: flex; }
            .dialog {
                position: relative;
                width: min(1720px, 99vw); height: min(98vh, 1180px); margin: auto;
                background: #f2f5f8; border: 1px solid #cdd8e3; border-radius: 14px;
                box-shadow: 0 24px 70px rgba(16,39,64,.35); display: flex; flex-direction: column; overflow: hidden;
            }

            .top { height: 64px; padding: 0 20px; background: linear-gradient(180deg, #1a73c7 0%, #12558f 100%); border-bottom: 3px solid #5aa9e6; color: #fff; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
            .top-icon { width: 22px; height: 22px; fill: none; stroke: #fff; stroke-width: 2; flex-shrink: 0; }
            .top-titles { flex: 1; }
            .top-titles h2 { margin: 0; font-size: 17px; font-weight: 800; }
            .top-titles small { opacity: .85; font-size: 11px; }
            .close { width: 32px; height: 32px; border: 1px solid rgba(255,255,255,.3); border-radius: 7px; background: rgba(255,255,255,.12); color: #fff; font-size: 19px; cursor: pointer; }
            .close:hover { background: rgba(198,40,40,.75); }

            .stats-strip { display: flex; align-items: center; gap: 18px; padding: 8px 20px; background: #eaf4fd; border-bottom: 1px solid #cfe4f7; flex-shrink: 0; }
            .stats-strip[hidden] { display: none; }
            .stats-main { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }
            .stats-main .count { font-weight: 800; color: #12558f; font-size: 13px; }
            .stats-main small { color: #45647f; font-size: 10.5px; }
            .stats-gse { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 3px 14px; max-height: 50px; overflow: auto; }
            .gse-bar-row { display: grid; grid-template-columns: 1fr 55px 30px; align-items: center; gap: 6px; font-size: 10px; }
            .gse-bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #34506a; }
            .gse-bar-track { height: 5px; background: #cfe4f7; border-radius: 99px; overflow: hidden; }
            .gse-bar-fill { height: 100%; background: linear-gradient(90deg, #1a73c7, #5aa9e6); }
            .gse-bar-count { text-align: right; color: #12558f; font-weight: 700; }

            .search-area { padding: 12px 20px 8px; background: #fff; border-bottom: 1px solid #dbe3ec; flex-shrink: 0; }
            .query-row { display: grid; grid-template-columns: 1fr auto; gap: 9px; }
            .query-wrap { position: relative; }
            .query-wrap svg { position: absolute; left: 12px; top: 50%; width: 17px; transform: translateY(-50%); fill: none; stroke: #7a8b9b; stroke-width: 2; }
            .query { width: 100%; height: 40px; padding: 0 12px 0 38px; border: 1px solid #bdc9d6; border-radius: 6px; outline: none; font-size: 13.5px; }
            .query:focus { border-color: #1a73c7; box-shadow: 0 0 0 3px rgba(26,115,199,.16); }
            .search { height: 40px; padding: 0 20px; border: none; border-radius: 6px; background: linear-gradient(135deg, #1a73c7, #12558f); color: #fff; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 7px; }
            .search:disabled { opacity: .5; cursor: not-allowed; }
            .search svg { width: 16px; fill: none; stroke: currentColor; stroke-width: 2; }
            .operators-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
            .operators-row .operators-label { font-size: 11px; font-weight: 700; color: #526477; text-transform: uppercase; letter-spacing: .03em; margin-right: 2px; }
            .operator { height: 25px; padding: 0 8px; border: 1px solid #cfe4f7; border-radius: 5px; background: #eaf4fd; color: #12558f; cursor: pointer; }
            .operator:hover { background: #d5e9fa; }

            .mode-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
            .mode-tab { height: 30px; padding: 0 13px; border: 1px solid #cfe4f7; border-radius: 99px; background: #eaf4fd; color: #12558f; font-size: 12px; font-weight: 700; cursor: pointer; }
            .mode-tab:hover { background: #d5e9fa; }
            .mode-tab.active { background: linear-gradient(135deg, #1a73c7, #12558f); color: #fff; border-color: transparent; }
            .semantic-mode[hidden] { display: none; }
            .semantic-query { width: 100%; min-height: 64px; padding: 10px 12px; border: 1px solid #bdc9d6; border-radius: 6px; outline: none; font-size: 13px; resize: vertical; font-family: inherit; }
            .semantic-query:focus { border-color: #1a73c7; box-shadow: 0 0 0 3px rgba(26,115,199,.16); }
            .semantic-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
            .semantic-search { height: 36px; padding: 0 16px; border: none; border-radius: 6px; background: linear-gradient(135deg, #1a73c7, #12558f); color: #fff; font-weight: 700; font-size: 12.5px; cursor: pointer; }
            .semantic-search:disabled { opacity: .5; cursor: not-allowed; }
            .semantic-limit-label { font-size: 12px; color: #45647f; display: flex; align-items: center; gap: 6px; }
            .semantic-limit-label select { height: 28px; padding: 0 6px; border: 1px solid #bdc9d6; border-radius: 5px; }
            .semantic-actions small { color: #7a8b9b; font-size: 11px; }

            .actions-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 9px 20px; background: #fff; border-bottom: 1px solid #dbe3ec; position: relative; flex-shrink: 0; }
            .btn { height: 32px; padding: 0 12px; border-radius: 6px; font-weight: 700; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
            .btn svg { width: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
            .btn-primary { border: none; background: linear-gradient(135deg, #1a73c7, #12558f); color: #fff; }
            .btn-secondary { border: 1px solid #bdc9d6; background: #fff; color: #34465a; }
            .btn-secondary:hover { background: #eaf4fd; }
            .btn-danger { border: 1px solid #d13438; background: #fff; color: #b42318; }
            .btn:disabled { opacity: .5; cursor: not-allowed; }
            .sort-select, .control-inline { height: 32px; padding: 0 8px; border: 1px solid #bdc9d6; border-radius: 6px; background: #fff; font-size: 12px; }
            .spacer { flex: 1; }
            .export-wrap { position: relative; }
            .export-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; background: #fff; border: 1px solid #cdd8e3; border-radius: 8px; box-shadow: 0 12px 28px rgba(16,39,64,.24); padding: 4px; min-width: 180px; }
            .export-menu[hidden] { display: none; }
            .export-menu button { width: 100%; text-align: left; padding: 8px 10px; border: 0; background: #fff; border-radius: 5px; cursor: pointer; font-size: 12.5px; }
            .export-menu button:hover { background: #eaf4fd; }

            .advanced-toggle-wrap { position: relative; }
            .advanced-toggle { display: inline-flex; align-items: center; gap: 6px; }
            .advanced-toggle svg { width: 12px; transition: transform .15s; }
            .advanced-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
            .advanced-panel {
                position: absolute; left: 0; top: calc(100% + 8px); z-index: 60;
                width: min(820px, 90vw); max-height: 60vh; overflow: auto;
                background: #fff; border: 1px solid #cdd8e3; border-radius: 10px;
                box-shadow: 0 16px 40px rgba(16,39,64,.28); padding: 16px;
                display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
            }
            .advanced-panel[hidden] { display: none; }
            .panel { padding: 13px; border: 1px solid #dfe7ef; border-radius: 8px; background: #f8fafc; }
            .panel h3 { margin: 0 0 11px; color: #4c6275; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
            .control label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; color: #526477; text-transform: uppercase; letter-spacing: .04em; }
            .control input, .control select { width: 100%; height: 36px; padding: 0 10px; border: 1px solid #bdc9d6; border-radius: 6px; background: #fff; }
            .people-grid { display: grid; gap: 10px; }
            .date-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
            .option-list { display: grid; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #e4eaf0; }
            .option { display: grid; grid-template-columns: 16px 1fr; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
            .option input { width: 15px; height: 15px; accent-color: #1a73c7; }
            .gse-tools { display: flex; gap: 6px; margin-bottom: 8px; }
            .tiny { height: 26px; padding: 0 9px; border: 1px solid #bdc9d6; border-radius: 5px; background: #fff; color: #466077; font-size: 11px; cursor: pointer; }
            .tiny:hover { background: #eaf4fd; }
            .tiny:disabled { opacity: .5; cursor: not-allowed; }
            .gse-list { max-height: 150px; padding: 8px; border: 1px solid #dce5ed; border-radius: 6px; background: #fff; overflow: auto; display: grid; gap: 6px; }
            .gse-item { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
            .gse-item input { accent-color: #1a73c7; }

            .person-control { position: relative; }
            .person-hint { display: block; margin-top: 4px; font-size: 10.5px; color: #7a8b9b; font-weight: 400; text-transform: none; letter-spacing: normal; }
            .specialist-menu {
                position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 80;
                max-height: 220px; overflow: auto; background: #fff; border: 1px solid #aebfcd; border-radius: 8px;
                box-shadow: 0 10px 26px rgba(32,55,78,.2); padding: 4px;
            }
            .specialist-menu[hidden] { display: none !important; }
            .specialist-option { width: 100%; padding: 8px 10px; border: 0; border-radius: 5px; background: #fff; color: #263746; text-align: left; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; }
            .specialist-option:hover, .specialist-option.active { background: #eaf4fd; color: #12558f; }
            .specialist-option strong { font-size: 12px; line-height: 1.3; }
            .specialist-option small { font-size: 10px; color: #68798a; align-self: center; }
            .specialist-option span { grid-column: 1/-1; font-size: 10px; color: #748394; }
            .specialist-message { padding: 10px; color: #647587; font-size: 11px; text-align: center; }
            .specialist-spinner { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid #cfe4f7; border-top-color: #1a73c7; border-radius: 50%; vertical-align: -2px; animation: tjspArchiveSpecialistSpin .65s linear infinite; }
            @keyframes tjspArchiveSpecialistSpin { to { transform: rotate(360deg); } }
            .person-hint.confirmed { color: #27633c; font-weight: 700; }

            .navigator { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; padding: 8px 20px; background: #fff; border-bottom: 1px solid #dbe3ec; flex-shrink: 0; }
            .navigator button.nav-btn { height: 30px; padding: 0 11px; border: 1px solid #bdc9d6; border-radius: 6px; background: #fff; color: #34465a; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
            .navigator button.nav-btn:hover:not(:disabled) { background: #eaf4fd; }
            .navigator button.nav-btn:disabled { opacity: .4; cursor: default; }
            .navigator svg { width: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
            .result-counter { min-width: 70px; text-align: center; font-size: 12px; font-weight: 700; color: #12558f; }
            .select-page { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: #34465a; cursor: pointer; }
            .select-page input { accent-color: #1a73c7; }
            .selection-count { font-size: 11.5px; font-weight: 700; color: #12558f; }
            .keyboard-help { font-size: 11px; color: #748293; }

            .progress { padding: 7px 20px; background: #eaf4fd; border-bottom: 1px solid #cfe4f7; flex-shrink: 0; }
            .progress[hidden] { display: none; }
            .progress-text { font-size: 12px; color: #12558f; }
            .track { height: 6px; margin-top: 6px; background: #cfe4f7; border-radius: 99px; overflow: hidden; }
            .fill { height: 100%; width: 0; background: linear-gradient(90deg, #1a73c7, #5aa9e6); transition: width .2s; }
            .status { padding: 7px 20px; font-size: 12.5px; flex-shrink: 0; }
            .status:empty { display: none; }
            .info { background: #eaf4fd; color: #12558f; } .success { background: #edf8f1; color: #27633c; }
            .warning { background: #fff7df; color: #795912; } .error { background: #fff0ef; color: #a11f19; }

            .results { padding: 16px 20px; overflow: auto; flex: 1; }
            .result-card { scroll-margin-top: 12px; background: #fff; border: 1px solid #d5e0ea; border-left: 4px solid #5aa9e6; border-radius: 10px; padding: 13px 16px; margin-bottom: 14px; box-shadow: 0 4px 14px rgba(35,62,88,.08); transition: box-shadow .15s, border-color .15s; }
            .result-card:hover { box-shadow: 0 7px 20px rgba(35,62,88,.12); }
            .result-card.active { border-color: #0d4d85; background: #f2f8fd; box-shadow: 0 0 0 2px rgba(13,77,133,.2), 0 8px 22px rgba(35,62,88,.14); }
            .result-card header { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
            .select-checkbox input { width: 16px; height: 16px; accent-color: #1a73c7; cursor: pointer; }
            .result-card header a { display: inline-flex; align-items: center; gap: 6px; color: #12558f; font-weight: 800; font-size: 14.5px; text-decoration: none; }
            .result-card header a svg { width: 15px; fill: none; stroke: currentColor; stroke-width: 2; }
            .result-card header a:hover { text-decoration: underline; }
            .vip-badge { font-size: 10px; font-weight: 800; color: #8a6300; background: #ffe9a8; border-radius: 4px; padding: 2px 7px; }
            .gse-tag { font-size: 10.5px; font-weight: 700; color: #12558f; background: #eaf4fd; border-radius: 4px; padding: 2px 8px; }
            .occ-badge { font-size: 10px; font-weight: 800; color: #27633c; background: #dcf3e4; border-radius: 4px; padding: 2px 7px; }
            .sim-badge { font-size: 10px; font-weight: 800; color: #12558f; background: #dcecfb; border: 1px solid #bcdcf5; border-radius: 4px; padding: 2px 7px; }
            .result-card header .date { margin-left: auto; font-size: 11px; color: #7a8b9b; }
            .icon-btn { width: 26px; height: 26px; padding: 0; border: 1px solid #cfe4f7; border-radius: 6px; background: #eaf4fd; color: #12558f; cursor: pointer; display: flex; align-items: center; justify-content: center; }
            .icon-btn:hover { background: #d5e9fa; }
            .icon-btn svg { width: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
            .result-card .field { margin-top: 9px; font-size: 13px; }
            .result-card .field strong { display: block; font-size: 10.5px; text-transform: uppercase; color: #466077; margin-bottom: 3px; }
            .result-card .field p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
            .result-card .field.collapsed p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
            .result-card .field mark { background: #ffe9a8; color: #5c4300; border-radius: 2px; padding: 0 1px; }
            .expand-text { margin-top: 6px; padding: 0; border: 0; background: transparent; color: #12558f; font-size: 11.5px; font-weight: 700; cursor: pointer; }
            .result-card footer { display: flex; gap: 20px; margin-top: 9px; padding-top: 9px; border-top: 1px solid #eef2f6; font-size: 12px; color: #2f4050; }
            .result-card footer small { display: block; font-size: 10px; text-transform: uppercase; color: #607287; margin-bottom: 2px; }
            .empty { padding: 60px; text-align: center; color: #6b7887; }
            .pagination { padding: 11px 20px; background: #fff; border-top: 1px solid #dbe3ec; display: flex; justify-content: center; align-items: center; gap: 12px; flex-shrink: 0; }
            .pagination button { height: 32px; padding: 0 12px; border: 1px solid #bdc9d6; background: #fff; border-radius: 6px; cursor: pointer; }
            .pagination button:disabled { opacity: .45; cursor: not-allowed; }
            .pagination span { font-size: 12px; color: #617082; }

            .focus-overlay { position: absolute; inset: 0; z-index: 25; padding: 18px; background: rgba(8,14,22,.5); backdrop-filter: blur(2px); display: flex; }
            .focus-overlay[hidden] { display: none; }
            .focus-body { width: min(1100px,100%); height: 100%; margin: auto; background: #fff; border: 1px solid #c9d6e1; border-top: 4px solid #5aa9e6; border-radius: 10px; box-shadow: 0 18px 50px rgba(15,35,55,.32); display: flex; flex-direction: column; overflow: hidden; }
            .focus-header { padding: 14px 18px; border-bottom: 1px solid #dfe7ee; background: #f8fafc; display: flex; align-items: center; gap: 14px; }
            .focus-header > div { flex: 1; display: grid; grid-template-columns: auto auto; gap: 3px 12px; align-items: center; }
            .focus-position { grid-column: 1/-1; color: #657689; font-size: 11px; }
            .focus-header a { color: #12558f; font-size: 19px; font-weight: 800; text-decoration: none; }
            .focus-header small { color: #657689; }
            .focus-select { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #34465a; cursor: pointer; flex-shrink: 0; }
            .focus-select input { accent-color: #1a73c7; width: 15px; height: 15px; }
            .focus-close { flex-shrink: 0; width: 34px; height: 34px; border: 1px solid #c9d5df; border-radius: 6px; background: #fff; font-size: 21px; cursor: pointer; }
            .focus-close:hover { background: #fdecec; border-color: #f3c9c7; }
            .focus-nav { height: 44px; padding: 6px 14px; background: #fff; border-bottom: 1px solid #dbe3ec; display: flex; align-items: center; justify-content: center; gap: 9px; flex: 0 0 auto; }
            .focus-nav button { height: 30px; padding: 0 12px; border: 1px solid #bdc9d6; border-radius: 6px; background: #fff; color: #34465a; font-weight: 600; cursor: pointer; }
            .focus-nav button:hover:not(:disabled) { background: #eaf4fd; }
            .focus-nav button:disabled { opacity: .42; cursor: default; }
            .focus-nav span { min-width: 100px; text-align: center; color: #12558f; font-size: 12px; font-weight: 700; }
            .focus-nav small { margin-left: auto; color: #748293; font-size: 11px; }
            .focus-scroll { padding: 18px; overflow: auto; flex: 1; }
            .focus-scroll section { padding: 0 0 18px; }
            .focus-scroll section + section { padding-top: 18px; border-top: 1px solid #e5ebf0; }
            .focus-scroll h3 { margin: 0 0 10px; color: #466077; font-size: 12px; text-transform: uppercase; }
            .focus-scroll section div { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; font-size: 14px; }
            .focus-scroll section div mark { background: #ffe9a8; color: #5c4300; border-radius: 2px; padding: 0 1px; }
            .focus-scroll footer { display: grid; grid-template-columns: 1fr 1fr 1.3fr; gap: 18px; padding: 14px; background: #f6f9fb; border: 1px solid #e2e9ef; border-radius: 8px; }
            .focus-scroll footer small { display: block; font-size: 10px; text-transform: uppercase; color: #607287; margin-bottom: 3px; }

            @media (max-width: 960px) {
                .advanced-panel, .date-grid { grid-template-columns: 1fr; }
                .stats-gse { display: none; }
                .keyboard-help { display: none; }
            }
        </style>
        <button class="launcher" type="button" title="Pesquisa completa no acervo SMAX"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"></path><circle cx="18" cy="18" r="3.2"></circle><path d="M20.3 20.3L23 23"></path></svg></button>
        <div class="overlay"><section class="dialog">
            <header class="top">
                <svg class="top-icon" viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"></path><circle cx="18" cy="18" r="3.2"></circle><path d="M20.3 20.3L23 23"></path></svg>
                <div class="top-titles"><h2>Pesquisa Completa no Acervo SMAX</h2><small>v${VERSION} · busca exaustiva, sem corte de relevância · agora com busca por semelhança (BM25, 100% local) — nada salvo em disco</small></div>
                <button class="close" type="button">×</button>
            </header>
            <div class="stats-strip" hidden>
                <div class="stats-main"><span class="count"></span><small class="loaded-at"></small><small class="range"></small></div>
                <div class="stats-gse"></div>
            </div>
            <section class="search-area">
                <div class="mode-tabs">
                    <button class="mode-tab active" data-mode="terms" type="button">🔤 Pesquisa por termos</button>
                    <button class="mode-tab" data-mode="semantic" type="button">🧭 Pesquisa por semelhança</button>
                </div>
                <div class="terms-mode">
                    <div class="query-row">
                        <div class="query-wrap"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.25"></circle><path d="M15.2 15.2L20 20"></path></svg><input class="query" type="text" placeholder='Ex.: "erro ao assinar" E eproc -certificado'></div>
                        <button class="search" type="button" disabled><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.25"></circle><path d="M15.2 15.2L20 20"></path></svg>Pesquisar no acervo</button>
                    </div>
                    <div class="operators-row"><span class="operators-label">Inserir:</span>
                        <button class="operator" data-insert='""' title="Frase exata">" "</button>
                        <button class="operator" data-insert=" E " title="E lógico">E</button>
                        <button class="operator" data-insert=" OU " title="OU lógico">OU</button>
                        <button class="operator" data-insert=" NÃO " title="NÃO lógico">NÃO</button>
                        <button class="operator" data-insert="()" title="Agrupar">( )</button>
                        <button class="operator" data-insert="-" title="Atalho de exclusão">−</button>
                    </div>
                </div>
                <div class="semantic-mode" hidden>
                    <textarea class="semantic-query" rows="3" placeholder="Cole aqui a descrição do chamado atual. O motor encontra, dentro do acervo já carregado, as solicitações mais parecidas por vocabulário (BM25) — 100% local, sem IA, nada enviado pra fora."></textarea>
                    <div class="semantic-actions">
                        <button class="semantic-search" type="button" disabled>🧭 Buscar casos semelhantes</button>
                        <label class="semantic-limit-label">Mostrar até
                            <select class="semantic-limit">
                                <option value="20">20</option>
                                <option value="50" selected>50</option>
                                <option value="100">100</option>
                                <option value="200">200</option>
                            </select> resultados
                        </label>
                        <small>Ctrl+Enter busca · funciona melhor com 1-3 frases descrevendo o caso.</small>
                    </div>
                </div>
            </section>
            <div class="actions-row">
                <button class="btn btn-primary load" type="button"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l4-4m-4 4l-4-4M4 17v3a1 1 0 001 1h14a1 1 0 001-1v-3"></path></svg>Carregar acervo completo</button>
                <button class="btn btn-danger cancel-load" type="button" hidden>Cancelar</button>
                <select class="field control-inline"><option value="both">Solução e descrição</option><option value="solution">Solução</option><option value="description">Descrição</option></select>
                <select class="mode control-inline"><option value="any">Qualquer palavra</option><option value="exact">Expressão exata</option></select>
                <select class="sort-select"><option value="recent">Mais recentes</option><option value="oldest">Mais antigas</option><option value="relevance">Mais ocorrências</option><option value="similarity">Mais semelhantes</option></select>
                <div class="advanced-toggle-wrap">
                    <button class="btn btn-secondary advanced-toggle" type="button" aria-expanded="false">Filtros avançados<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>
                    <div class="advanced-panel" hidden>
                        <section class="panel"><h3>Pessoas</h3><div class="people-grid">
                            <div class="control person-control"><label>Solicitado para</label><input class="requested-for" placeholder="Digite 2+ letras para sugestões" autocomplete="off"><small class="person-hint">Escolher uma sugestão restringe o carregamento a essa pessoa (mais rápido)</small></div>
                            <div class="control person-control"><label>Designado Especialista</label><input class="specialist" placeholder="Digite 2+ letras para sugestões" autocomplete="off"><small class="person-hint">Escolher uma sugestão restringe o carregamento a essa pessoa (mais rápido)</small></div>
                        </div>
                        <label class="option" style="margin-top:10px"><input class="vip-only" type="checkbox"><span>Somente solicitantes VIP</span></label>
                        <h3 style="margin-top:14px">Data de criação</h3>
                        <div class="date-grid">
                            <div class="control"><label>Critério</label><select class="date-mode"><option value="any">Qualquer data</option><option value="on">Em uma data</option><option value="after">A partir de</option><option value="before">Até uma data</option><option value="between">Entre duas datas</option></select></div>
                            <div class="control date-from-wrap" hidden><label class="date-from-label">Data</label><input class="date-from" type="date"></div>
                            <div class="control date-to-wrap" hidden><label class="date-to-label">Até</label><input class="date-to" type="date"></div>
                        </div></section>
                        <section class="panel"><h3>GSEs incluídas na carga</h3>
                            <div class="gse-tools"><button class="tiny select-all" type="button">Selecionar todas</button><button class="tiny clear-gse" type="button">Limpar</button></div>
                            <div class="gse-list"></div>
                        </section>
                        <section class="panel" style="grid-column:1/-1"><h3>Opções de correspondência</h3><div class="option-list">
                            <label class="option"><input class="ignore-case" type="checkbox" checked><span>Ignorar maiúsculas/minúsculas</span></label>
                            <label class="option"><input class="ignore-accents" type="checkbox" checked><span>Ignorar acentos</span></label>
                        </div></section>
                    </div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-secondary copy" type="button" disabled><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg>Copiar resumo</button>
                <div class="export-wrap">
                    <button class="btn btn-secondary export-toggle" type="button" disabled><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l4-4m-4 4l-4-4M4 21h16"></path></svg>Exportar</button>
                    <div class="export-menu" hidden>
                        <button class="export-csv" type="button">📄 CSV (Excel)</button>
                        <button class="export-json" type="button">🗂 JSON</button>
                        <button class="export-txt" type="button">📝 TXT (relatório)</button>
                        <button class="export-html" type="button">🌐 HTML (imprimível/PDF)</button>
                    </div>
                </div>
            </div>
            <nav class="navigator">
                <button class="nav-btn previous-result" type="button" disabled><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"></path></svg>Anterior</button>
                <span class="result-counter"></span>
                <button class="nav-btn next-result" type="button" disabled>Próximo<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>
                <button class="nav-btn focus-result" type="button" disabled><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg>Expandir</button>
                <span class="spacer"></span>
                <label class="select-page"><input type="checkbox" class="select-page-checkbox">Marcar página</label>
                <button class="tiny select-all-results" type="button">Marcar todos os resultados</button>
                <span class="selection-count"></span>
                <button class="tiny clear-selection" type="button" hidden>Limpar seleção</button>
                <button class="tiny open-selected" type="button" disabled>Abrir selecionadas</button>
                <span class="keyboard-help">Teclas ↑ e ↓ navegam · Enter expande</span>
            </nav>
            <div class="progress" hidden><div class="progress-text"></div><div class="track"><div class="fill"></div></div></div>
            <div class="status"></div>
            <main class="results"><div class="empty">Carregue o acervo completo e pesquise.</div></main>
            <footer class="pagination" hidden><button class="prev-page">Anterior</button><span class="page-info"></span><button class="next-page">Próxima</button></footer>
            <div class="focus-overlay" hidden><div class="focus-body"></div></div>
        </section></div>`;

        ui = {
            launcher: shadow.querySelector(".launcher"), overlay: shadow.querySelector(".overlay"), close: shadow.querySelector(".close"),
            statsStrip: shadow.querySelector(".stats-strip"), statsCount: shadow.querySelector(".count"), statsLoadedAt: shadow.querySelector(".loaded-at"), statsRange: shadow.querySelector(".range"), statsGseList: shadow.querySelector(".stats-gse"),
            query: shadow.querySelector(".query"), search: shadow.querySelector(".search"),
            termsMode: shadow.querySelector(".terms-mode"), semanticMode: shadow.querySelector(".semantic-mode"),
            semanticQuery: shadow.querySelector(".semantic-query"), semanticSearch: shadow.querySelector(".semantic-search"), semanticLimit: shadow.querySelector(".semantic-limit"),
            field: shadow.querySelector(".field"), mode: shadow.querySelector(".mode"), sortSelect: shadow.querySelector(".sort-select"),
            loadButton: shadow.querySelector(".load"), cancelLoad: shadow.querySelector(".cancel-load"),
            advancedToggleWrap: shadow.querySelector(".advanced-toggle-wrap"), advancedToggle: shadow.querySelector(".advanced-toggle"), advancedPanel: shadow.querySelector(".advanced-panel"),
            requestedFor: shadow.querySelector(".requested-for"), specialist: shadow.querySelector(".specialist"), vipOnly: shadow.querySelector(".vip-only"),
            dateMode: shadow.querySelector(".date-mode"), dateFrom: shadow.querySelector(".date-from"), dateTo: shadow.querySelector(".date-to"),
            dateFromWrap: shadow.querySelector(".date-from-wrap"), dateToWrap: shadow.querySelector(".date-to-wrap"), dateFromLabel: shadow.querySelector(".date-from-label"), dateToLabel: shadow.querySelector(".date-to-label"),
            gseList: shadow.querySelector(".gse-list"), ignoreCase: shadow.querySelector(".ignore-case"), ignoreAccents: shadow.querySelector(".ignore-accents"),
            copyButton: shadow.querySelector(".copy"), exportToggle: shadow.querySelector(".export-toggle"), exportWrap: shadow.querySelector(".export-wrap"), exportMenu: shadow.querySelector(".export-menu"),
            previousResult: shadow.querySelector(".previous-result"), nextResult: shadow.querySelector(".next-result"), focusResult: shadow.querySelector(".focus-result"), resultCounter: shadow.querySelector(".result-counter"),
            selectPageCheckbox: shadow.querySelector(".select-page-checkbox"), selectAllResultsButton: shadow.querySelector(".select-all-results"),
            selectionCount: shadow.querySelector(".selection-count"), clearSelectionButton: shadow.querySelector(".clear-selection"), openSelectedButton: shadow.querySelector(".open-selected"),
            progress: shadow.querySelector(".progress"), progressText: shadow.querySelector(".progress-text"), progressBar: shadow.querySelector(".fill"),
            status: shadow.querySelector(".status"), results: shadow.querySelector(".results"),
            pagination: shadow.querySelector(".pagination"), prevPage: shadow.querySelector(".prev-page"), nextPage: shadow.querySelector(".next-page"), pageInfo: shadow.querySelector(".page-info"),
            focusOverlay: shadow.querySelector(".focus-overlay"), focusBody: shadow.querySelector(".focus-body"),
            exportButton: shadow.querySelector(".export-toggle")
        };

        buildGseList();

        ui.launcher.addEventListener("click", () => host.classList.add("open"));
        ui.close.addEventListener("click", () => host.classList.remove("open"));
        ui.overlay.addEventListener("click", event => { if (event.target === ui.overlay) host.classList.remove("open"); });

        ui.loadButton.addEventListener("click", loadArchive);
        ui.cancelLoad.addEventListener("click", () => { archiveCancelled = true; });
        ui.search.addEventListener("click", performSearch);
        ui.query.addEventListener("keydown", event => { if (event.key === "Enter" && !ui.search.disabled) performSearch(); });
        shadow.querySelectorAll(".mode-tab").forEach(tab => tab.addEventListener("click", () => {
            const mode = tab.dataset.mode;
            shadow.querySelectorAll(".mode-tab").forEach(other => other.classList.toggle("active", other === tab));
            ui.termsMode.hidden = mode !== "terms";
            ui.semanticMode.hidden = mode !== "semantic";
        }));
        ui.semanticSearch.addEventListener("click", performSemanticSearch);
        ui.semanticQuery.addEventListener("keydown", event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !ui.semanticSearch.disabled) { event.preventDefault(); performSemanticSearch(); }
        });
        ui.sortSelect.addEventListener("change", () => { sortMode = ui.sortSelect.value; applySort(); currentPage = 1; renderResults(); });
        ui.prevPage.addEventListener("click", () => { currentPage--; renderResults(); });
        ui.nextPage.addEventListener("click", () => { currentPage++; renderResults(); });

        ui.previousResult.addEventListener("click", () => moveResult(-1));
        ui.nextResult.addEventListener("click", () => moveResult(1));
        ui.focusResult.addEventListener("click", () => openFocus(activeIndex));
        ui.selectPageCheckbox.addEventListener("change", () => {
            const start = (currentPage - 1) * PAGE_RESULTS;
            results.slice(start, start + PAGE_RESULTS).forEach(item => setSelection(item.id, ui.selectPageCheckbox.checked));
            renderResults();
        });
        ui.selectAllResultsButton.addEventListener("click", selectAllResults);
        ui.clearSelectionButton.addEventListener("click", clearSelection);
        ui.openSelectedButton.addEventListener("click", openSelectedInTabs);

        shadow.querySelectorAll(".operator").forEach(button => button.addEventListener("click", () => insertOperator(button.dataset.insert || "")));
        shadow.querySelector(".select-all").addEventListener("click", () => ui.gseList.querySelectorAll("input").forEach(input => input.checked = true));
        shadow.querySelector(".clear-gse").addEventListener("click", () => ui.gseList.querySelectorAll("input").forEach(input => input.checked = false));
        ui.dateMode.addEventListener("change", updateDateControls);

        function closeAdvancedPanel() { ui.advancedPanel.hidden = true; ui.advancedToggle.setAttribute("aria-expanded", "false"); }
        ui.advancedToggle.addEventListener("click", () => {
            const willOpen = ui.advancedPanel.hidden;
            ui.advancedPanel.hidden = !willOpen;
            ui.advancedToggle.setAttribute("aria-expanded", String(willOpen));
        });

        function closeExportMenu() { ui.exportMenu.hidden = true; }
        ui.exportToggle.addEventListener("click", () => { ui.exportMenu.hidden = !ui.exportMenu.hidden; });
        shadow.querySelector(".export-csv").addEventListener("click", () => { exportCsv(); closeExportMenu(); });
        shadow.querySelector(".export-json").addEventListener("click", () => { exportJson(); closeExportMenu(); });
        shadow.querySelector(".export-txt").addEventListener("click", () => { exportTxt(); closeExportMenu(); });
        shadow.querySelector(".export-html").addEventListener("click", () => { exportHtml(); closeExportMenu(); });
        ui.copyButton.addEventListener("click", copySummary);

        shadow.addEventListener("mousedown", event => {
            if (!ui.advancedPanel.hidden && !event.composedPath().includes(ui.advancedToggleWrap)) closeAdvancedPanel();
            if (!ui.exportMenu.hidden && !event.composedPath().includes(ui.exportWrap)) closeExportMenu();
        });

        // Listener global de teclado registrado em document (fora da shadow DOM):
        // eventos que cruzam essa fronteira sofrem "retargeting", então usamos
        // event.composedPath()[0] em vez de event.target para saber o alvo real
        // (senão as setas sequestrariam a navegação mesmo digitando num campo).
        document.addEventListener("keydown", event => {
            if (!host.classList.contains("open")) return;
            const realTarget = typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
            const tag = realTarget && realTarget.tagName ? realTarget.tagName.toLowerCase() : "";
            const typing = ["input", "textarea", "select"].includes(tag);
            if (!typing && event.key === "ArrowDown") { event.preventDefault(); moveResult(1); }
            else if (!typing && event.key === "ArrowUp") { event.preventDefault(); moveResult(-1); }
            else if (!typing && event.key === "Enter" && focusedIndex < 0 && activeIndex >= 0) { event.preventDefault(); openFocus(activeIndex); }
            else if (event.key === "Escape") {
                if (focusedIndex >= 0) closeFocus();
                else if (!ui.exportMenu.hidden) closeExportMenu();
                else if (!ui.advancedPanel.hidden) closeAdvancedPanel();
                else host.classList.remove("open");
            }
        });

        updateDateControls();
        updateNavigator();
        updateSelectionUi();
        installPersonAutocomplete(ui.requestedFor, shadow);
        installPersonAutocomplete(ui.specialist, shadow);
    }

    function init() {
        if (document.getElementById("tjsp-archive-full-host")) return;
        buildUi();
        console.log(`[TJSP] Pesquisa Completa no Acervo SMAX ${VERSION} carregada.`);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
}());
