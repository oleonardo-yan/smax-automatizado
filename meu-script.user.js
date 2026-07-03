// ==UserScript==
// @name         TJSP Suporte - Robo de Automacoes
// @namespace    http://tampermonkey.net/
// @version      1.8.15
// @description  Robo de opcoes automatizadas para o suporte TJSP
// @author       Leonardo
// @match        https://suporte.tjsp.jus.br/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    var STORAGE_ETAPA = "tjsp_auto_etapa_recebimento";
    var STORAGE_PRIMEIRO_NOME = "tjsp_auto_primeiro_nome_solicitante";
    var ETAPA_CAPTURAR_NOME_NA_GERAL = "capturar_nome_na_geral";
    var ETAPA_EXECUTAR_NA_DISCUSSAO = "executar_na_discussao";
    var VALOR_PARA_USUARIO = "User";
    var VALOR_OBJETIVO_ATUALIZACAO = "StatusUpdate";
    var TEXTO_IDENTIFICADOR_ASSINATURA = "Agradecemos seu contato e permanecemos";
    var ASSINATURA_SUPORTE_HTML = "<p>Agradecemos seu contato e permanecemos &agrave; disposi&ccedil;&atilde;o!</p><p>Atenciosamente,<br>SGS 2.2.1 - Servi&ccedil;o de Suporte - 1&ordf; Inst&acirc;ncia</p>";
    var HASH_DESTAQUE_ABERTURA = "tjspAutoAbertoPesquisa";
    var TITULO_PREFIXO_CONSULTA = "🔵 ";
    var fluxoEmAndamento = false;
    var contadorToolbar = 0;
    var intervaloDestaqueGuia = null;

    var TRATAMENTO_POR_NOME = {
        "maria":"f","ana":"f","julia":"f","juliana":"f","mariana":"f","patricia":"f","fernanda":"f","carla":"f","camila":"f","bruna":"f","renata":"f","luciana":"f","adriana":"f","marina":"f","vivian":"f","viviane":"f",
        "joao":"m","jose":"m","antonio":"m","carlos":"m","paulo":"m","pedro":"m","lucas":"m","leonardo":"m","marcos":"m","ricardo":"m","roberto":"m","fernando":"m","rafael":"m"
    };

    function criarEvento(tipo) {
        try { var ev = document.createEvent("Event"); ev.initEvent(tipo, true, true); return ev; }
        catch (e) { try { return new Event(tipo, { bubbles: true, cancelable: true }); } catch (erro) { return null; } }
    }

    function dispararEventos(el) {
        var lista = ["input", "change", "keyup", "keydown", "blur"], i, ev;
        if (!el) { return; }
        for (i = 0; i < lista.length; i++) { ev = criarEvento(lista[i]); if (ev) { el.dispatchEvent(ev); } }
    }

    function sleep(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }

    function waitForCondition(fn, timeoutMs, intervalMs) {
        var start = Date.now(); timeoutMs = timeoutMs || 10000; intervalMs = intervalMs || 300;
        return new Promise(function (resolve) {
            function check() {
                var ok = false;
                try { ok = !!fn(); } catch (e) { ok = false; }
                if (ok) { resolve(true); return; }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                window.setTimeout(check, intervalMs);
            }
            check();
        });
    }

    function normalizarTexto(txt) {
        var texto = txt || "";
        try { texto = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
        return texto.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function tituloNome(nome) {
        var partes = String(nome || "").toLowerCase().split(/\s+/), res = [], i, p;
        for (i = 0; i < partes.length; i++) { p = partes[i]; if (p) { res.push(p.charAt(0).toUpperCase() + p.slice(1)); } }
        return res.join(" ");
    }

    function elementoVisivel(el) {
        if (!el) { return false; }
        var r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    }

    function gerarDadosUrlRequest() {
        var m = location.pathname.match(/\/saw\/Request\/\d+/i);
        return m ? { base: location.origin + m[0], query: location.search || "" } : null;
    }
    function gerarUrlGeral() { var d = gerarDadosUrlRequest(); return d ? d.base + "/general" + d.query : ""; }
    function gerarUrlDiscussoes() { var d = gerarDadosUrlRequest(); return d ? d.base + "/discussions" + d.query : ""; }
    function estaEmTelaDeChamado() { return /\/saw\/Request\/\d+/i.test(location.pathname); }

    function estaNaAbaGeral() {
        var url = location.href.toLowerCase(), campoUsuario;
        if (url.indexOf("/general") >= 0 || document.querySelector("#tab-0.active")) { return true; }
        campoUsuario = document.querySelector("input[name='Usuario_c'], input[id$='_Usuario_c']");
        return !!campoUsuario && elementoVisivel(campoUsuario);
    }

    function estaNaAbaDiscussoes() {
        return location.href.toLowerCase().indexOf("/discussions") >= 0 || !!document.querySelector("#tab-8.active");
    }

    function limparNomeSolicitante(raw) {
        var nome, partes, validas = [], i;
        if (!raw) { return ""; }
        nome = String(raw).replace(/\s+/g, " ").replace(/\([^)]*\)/g, "").replace(/<[^>]+>/g, "").replace(/[:*]/g, "").trim();
        if (nome.indexOf("@") >= 0) { nome = nome.split("@")[0].replace(/[._-]+/g, " "); }
        nome = nome.split("|")[0].split("/")[0].trim();
        partes = nome.split(/\s+/);
        for (i = 0; i < partes.length; i++) { if (/^[A-Za-z\u00C0-\u00FF]{2,}$/.test(partes[i])) { validas.push(partes[i]); } }
        return validas.join(" ");
    }

    function obterPrimeiroNomeUsuarioNaGeral() {
        var seletores = ["input[name='Usuario_c']", "input[id$='_Usuario_c']"], i, campo, nomeLimpo, primeiroNome;
        if (!estaNaAbaGeral()) { return ""; }
        for (i = 0; i < seletores.length; i++) {
            campo = document.querySelector(seletores[i]);
            if (campo && campo.value && campo.value.trim()) {
                nomeLimpo = limparNomeSolicitante(campo.value);
                primeiroNome = nomeLimpo.split(/\s+/)[0];
                if (primeiroNome) { return tituloNome(primeiroNome); }
            }
        }
        return "";
    }

    function montarSaudacao() {
        var primeiroNome = sessionStorage.getItem(STORAGE_PRIMEIRO_NOME) || "", nomeNorm, tratamento;
        if (!primeiroNome) { return "Prezado(a) usuario(a),"; }
        nomeNorm = normalizarTexto(primeiroNome); tratamento = TRATAMENTO_POR_NOME[nomeNorm];
        if (tratamento === "f") { return "Prezada senhora " + primeiroNome + ","; }
        if (tratamento === "m") { return "Prezado senhor " + primeiroNome + ","; }
        return "Prezado(a) " + primeiroNome + ",";
    }

    function montarTextoPadrao() {
        return { textoHtml: [
            "<p>", montarSaudacao(), "</p>",
            "<p>Informamos que a solicita&ccedil;&atilde;o foi recebida e est&aacute; sendo analisada por este suporte com a devida prioridade.</p>",
            "<p>As atualiza&ccedil;&otilde;es ser&atilde;o comunicadas por este canal.</p>",
            "<p>Atenciosamente, SGS 2.2.1</p>"
        ].join("") };
    }

    function selecionarSelectNativo(select, valor) {
        var opcoes, existe = false, i;
        if (!select) { return false; }
        opcoes = Array.prototype.slice.call(select.options || []);
        for (i = 0; i < opcoes.length; i++) { if (opcoes[i].value === valor) { existe = true; break; } }
        if (!existe) { return false; }
        select.value = valor;
        if (window.jQuery) { try { window.jQuery(select).val(valor).trigger("change"); } catch (e) {} }
        dispararEventos(select);
        return select.value === valor;
    }

    function localizarContainerComentarioAtual() { return document.querySelector(".comment-item.currentUserComment") || document.querySelector(".currentUserComment"); }
    function localizarSelectPara() { var c = localizarContainerComentarioAtual(); return c ? c.querySelector("select[ng-model='newComment.CommentTo']") : null; }
    function localizarSelectObjetivo() { var c = localizarContainerComentarioAtual(); return c ? c.querySelector("select[ng-model='newComment.FunctionalPurpose']") : null; }

    function localizarEditorDiscussao() {
        var c = localizarContainerComentarioAtual();
        return c ? c.querySelector("[contenteditable='true'].cke_wysiwyg_div, [contenteditable='true'][role='textbox'], .cke_wysiwyg_div[contenteditable='true']") : null;
    }

    function localizarEditorGeralSolucao() {
        var editores, i, editor;
        if (!estaNaAbaGeral()) { return null; }
        editores = document.querySelectorAll("[contenteditable='true'].cke_wysiwyg_div, [contenteditable='true'][role='textbox'], .cke_wysiwyg_div[contenteditable='true']");
        for (i = 0; i < editores.length; i++) {
            editor = editores[i];
            if (editor.getAttribute("aria-label") === "Solução" && elementoVisivel(editor)) { return editor; }
        }
        return null;
    }

    function localizarEditorOperacional() {
        var editor;
        if (estaNaAbaDiscussoes()) { editor = localizarEditorDiscussao(); if (editor) { return editor; } }
        if (estaNaAbaGeral()) { editor = localizarEditorGeralSolucao(); if (editor) { return editor; } }
        return null;
    }

    function obterInstanciaCKEditorDoEditor(editor) {
        var nome, instance, editable;
        if (!editor || !window.CKEDITOR || !window.CKEDITOR.instances) { return null; }
        try {
            for (nome in window.CKEDITOR.instances) {
                if (Object.prototype.hasOwnProperty.call(window.CKEDITOR.instances, nome)) {
                    instance = window.CKEDITOR.instances[nome]; editable = instance.editable && instance.editable();
                    if (editable && editable.$ === editor) { return instance; }
                }
            }
        } catch (e) {}
        return null;
    }

    function sincronizarEditor(editor) {
        var instance;
        if (!editor) { return; }
        dispararEventos(editor);
        instance = obterInstanciaCKEditorDoEditor(editor);
        if (instance) { try { if (instance.updateElement) { instance.updateElement(); } instance.fire("change"); } catch (e) {} }
    }

    function inserirAssinaturaNoEditor(editor) {
        var textoAtual, htmlAtual;
        if (!editor) { return false; }
        textoAtual = editor.textContent || "";
        if (textoAtual.indexOf(TEXTO_IDENTIFICADOR_ASSINATURA) >= 0) { alert("A assinatura da caneta ja parece estar inserida."); return false; }
        editor.focus(); htmlAtual = (editor.innerHTML || "").replace(/\s+$/g, "");
        editor.innerHTML = htmlAtual + ASSINATURA_SUPORTE_HTML;
        sincronizarEditor(editor);
        return true;
    }

    function ocultarMarcadoresResizeImagem(img) {
        var editor, cke, marcadores, i;
        if (!img) { return; }
        editor = img.closest("[contenteditable='true']"); if (!editor) { return; }
        cke = editor.closest(".cke") || editor;
        marcadores = cke.querySelectorAll(".cke_image_resizer,.cke_widget_drag_handler_container,[data-cke-widget-resizer],.cke_widget_wrapper .cke_image_resizer,.cke_widget_selected .cke_image_resizer");
        for (i = 0; i < marcadores.length; i++) {
            marcadores[i].style.setProperty("display", "none", "important");
            marcadores[i].style.setProperty("visibility", "hidden", "important");
            marcadores[i].style.setProperty("opacity", "0", "important");
            marcadores[i].style.setProperty("width", "0", "important");
            marcadores[i].style.setProperty("height", "0", "important");
            marcadores[i].style.setProperty("border", "0", "important");
            marcadores[i].style.setProperty("padding", "0", "important");
            marcadores[i].style.setProperty("margin", "0", "important");
        }
    }

    function aplicarBordaImagem(img) {
        if (!img) { return; }
        img.classList.add("tjsp-auto-imagem-formatada");
        img.style.border = "4px solid #004b8d"; img.style.borderRadius = "4px"; img.style.boxSizing = "border-box";
        img.style.padding = "0"; img.style.marginTop = "10px"; img.style.marginBottom = "10px";
        img.style.outline = "none"; img.style.boxShadow = "none";
        ocultarMarcadoresResizeImagem(img);
    }

    function formatarImagensNoEditor(editor, exibirAlerta) {
        var imagens, i;
        if (!editor) { return false; }
        imagens = editor.querySelectorAll("img");
        if (!imagens.length) { if (exibirAlerta) { alert("Nenhuma imagem foi encontrada no editor atual."); } return false; }
        for (i = 0; i < imagens.length; i++) { aplicarBordaImagem(imagens[i]); }
        sincronizarEditor(editor);
        return true;
    }

    function normalizarConteudoTextoNoEditor(editor) {
        var blocos, i, el, texto, temConteudoPreservado, htmlAntes, html, alterou = false;
        if (!editor) { return false; }
        blocos = editor.querySelectorAll("p, div");
        for (i = blocos.length - 1; i >= 0; i--) {
            el = blocos[i]; texto = (el.textContent || "").replace(/\u00A0/g, " ").trim();
            temConteudoPreservado = !!el.querySelector("img, table, video, canvas, svg, iframe, input, select, textarea");
            if (!texto && !temConteudoPreservado) { el.parentNode.removeChild(el); alterou = true; }
        }
        blocos = editor.querySelectorAll("p, div");
        for (i = 0; i < blocos.length; i++) {
            el = blocos[i]; el.style.marginTop = "0"; el.style.marginBottom = "10px";
            el.style.paddingTop = "0"; el.style.paddingBottom = "0"; el.style.lineHeight = "1.35"; alterou = true;
        }
        blocos = editor.querySelectorAll("li");
        for (i = 0; i < blocos.length; i++) {
            el = blocos[i]; el.style.marginTop = "0"; el.style.marginBottom = "4px";
            el.style.paddingTop = "0"; el.style.paddingBottom = "0"; el.style.lineHeight = "1.35"; alterou = true;
        }
        htmlAntes = editor.innerHTML || "";
        html = htmlAntes
            .replace(/&nbsp;/gi, " ")
            .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>")
            .replace(/<(p|div)([^>]*)>\s*<br\s*\/?>\s*<\/\1>/gi, "")
            .replace(/<(p|div)([^>]*)>\s*<\/\1>/gi, "")
            .replace(/^(\s|<br\s*\/?>)+/gi, "")
            .replace(/(\s|<br\s*\/?>)+$/gi, "");
        if (html !== htmlAntes) {
            editor.innerHTML = html; alterou = true;
            blocos = editor.querySelectorAll("p, div");
            for (i = 0; i < blocos.length; i++) {
                blocos[i].style.marginTop = "0"; blocos[i].style.marginBottom = "10px"; blocos[i].style.paddingTop = "0"; blocos[i].style.paddingBottom = "0"; blocos[i].style.lineHeight = "1.35";
            }
        }
        if (alterou) { sincronizarEditor(editor); }
        return alterou;
    }

    function formatarConteudoNoEditor(editor) {
        var textoAlterado, imagensAlteradas;
        if (!editor) { return false; }
        imagensAlteradas = formatarImagensNoEditor(editor, false);
        textoAlterado = normalizarConteudoTextoNoEditor(editor);
        sincronizarEditor(editor);
        return imagensAlteradas || textoAlterado;
    }

    function formatarImagensEditor() {
        var editor = localizarEditorOperacional();
        if (!editor) { alert(["Nao encontrei o editor adequado para formatar a resposta.", "", "Na aba Geral, use o campo Solução.", "Na aba Discussões, abra a área de comentário."].join("\n")); return false; }
        return formatarConteudoNoEditor(editor);
    }

    function editorEhOperacional(editor) {
        var container;
        if (!editor || !elementoVisivel(editor)) { return false; }
        if (editor.getAttribute("aria-label") === "Solução") { return true; }
        container = localizarContainerComentarioAtual();
        return !!(container && container.contains(editor));
    }

    function localizarBarraDoEditor(editor) {
        var cke;
        if (!editor) { return null; }
        cke = editor.closest(".cke"); if (!cke) { return null; }
        return cke.querySelector(".cke_top .cke_toolbox") || cke.querySelector(".cke_toolbox") || cke.querySelector(".cke_top");
    }

    function criarSvgCaneta() {
        return ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<path d='M4 20h4.6L19.2 9.4a2.2 2.2 0 0 0 0-3.1L17.7 4.8a2.2 2.2 0 0 0-3.1 0L4 15.4V20z' stroke-width='2' stroke-linejoin='round'/>", "<path d='M13.8 5.8l4.4 4.4' stroke-width='2' stroke-linecap='round'/>", "<path d='M4 20l4.2-1.1' stroke-width='2' stroke-linecap='round'/>", "</svg>"].join("");
    }

    function criarSvgImagem() {
        return ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<rect x='3.8' y='5' width='16.4' height='14' rx='2.2' stroke-width='2'/>", "<circle cx='8.6' cy='9.4' r='1.45' stroke-width='1.8'/>", "<path d='M5.4 17l5-5 3.1 3.1 2-2L18.8 17' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>", "</svg>"].join("");
    }

    function aplicarEstiloInlineBotaoToolbar(el, classeExtra) {
        el.style.setProperty("width", "30px", "important"); el.style.setProperty("height", "30px", "important");
        el.style.setProperty("min-width", "30px", "important"); el.style.setProperty("min-height", "30px", "important");
        el.style.setProperty("padding", "0", "important"); el.style.setProperty("border", "1px solid #005a9e", "important");
        el.style.setProperty("border-radius", "8px", "important"); el.style.setProperty("cursor", "pointer", "important");
        el.style.setProperty("display", "inline-flex", "important"); el.style.setProperty("align-items", "center", "important");
        el.style.setProperty("justify-content", "center", "important"); el.style.setProperty("box-sizing", "border-box", "important");
        el.style.setProperty("opacity", "1", "important"); el.style.setProperty("filter", "none", "important");
        el.style.setProperty("box-shadow", "0 2px 6px rgba(0,90,158,.35), inset 0 1px 0 rgba(255,255,255,.35)", "important");
        if (classeExtra === "tjsp-editor-btn-assinar") { el.style.setProperty("background", "linear-gradient(135deg,#005a9e,#0078d4)", "important"); }
        else { el.style.setProperty("background", "linear-gradient(135deg,#004b8d,#00a2ed)", "important"); }
    }

    function criarBotaoToolbar(svgHtml, titulo, classeExtra, callback) {
        var btn = document.createElement("span");
        btn.className = "tjsp-editor-toolbar-btn " + classeExtra; btn.innerHTML = svgHtml; btn.title = titulo;
        btn.setAttribute("role", "button"); btn.setAttribute("tabindex", "0"); btn.setAttribute("aria-label", titulo);
        aplicarEstiloInlineBotaoToolbar(btn, classeExtra);
        Array.prototype.forEach.call(btn.querySelectorAll("svg"), function (svg) {
            svg.style.setProperty("width", "18px", "important"); svg.style.setProperty("height", "18px", "important");
            svg.style.setProperty("stroke", "#ffffff", "important"); svg.style.setProperty("opacity", "1", "important");
            svg.style.setProperty("filter", "drop-shadow(0 1px 1px rgba(0,0,0,.28))", "important");
        });
        btn.addEventListener("mousedown", function (event) { event.preventDefault(); event.stopPropagation(); });
        btn.addEventListener("mouseenter", function () { btn.style.setProperty("filter", "saturate(1.18) brightness(1.10)", "important"); btn.style.setProperty("transform", "translateY(-1px)", "important"); });
        btn.addEventListener("mouseleave", function () { btn.style.setProperty("filter", "none", "important"); btn.style.setProperty("transform", "translateY(0)", "important"); });
        btn.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); callback(); } });
        btn.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); callback(); });
        return btn;
    }

    function instalarBotoesNoEditor(editor) {
        var barra, grupo, id;
        if (!editorEhOperacional(editor)) { return; }
        barra = localizarBarraDoEditor(editor); if (!barra) { return; }
        if (editor.getAttribute("data-tjsp-toolbar-id")) { return; }
        contadorToolbar += 1; id = "tjsp-editor-toolbar-" + contadorToolbar;
        editor.setAttribute("data-tjsp-toolbar-id", id);
        grupo = document.createElement("span"); grupo.id = id; grupo.className = "tjsp-editor-toolbar-group";
        grupo.appendChild(criarBotaoToolbar(criarSvgCaneta(), "Assinar resposta", "tjsp-editor-btn-assinar", function () { inserirAssinaturaNoEditor(editor); }));
        grupo.appendChild(criarBotaoToolbar(criarSvgImagem(), "Formatar resposta", "tjsp-editor-btn-imagens", function () { formatarConteudoNoEditor(editor); }));
        barra.appendChild(grupo);
    }

    function instalarBotoesEditores() {
        var editores = document.querySelectorAll("[contenteditable='true'].cke_wysiwyg_div, [contenteditable='true'][role='textbox'], .cke_wysiwyg_div[contenteditable='true']"), i;
        for (i = 0; i < editores.length; i++) { instalarBotoesNoEditor(editores[i]); }
    }

    function deveMostrarPesquisaChamado() { return /^\/saw\//i.test(location.pathname); }
    function sanitizarNumeroChamado(valor) { return String(valor || "").replace(/\D+/g, ""); }
    function montarUrlChamado(numeroChamado) { return location.origin + "/saw/Request/" + numeroChamado + "/general#" + HASH_DESTAQUE_ABERTURA; }

    function sinalizarPesquisaChamadoInvalida(input) {
        if (!input) { return; }
        input.classList.remove("tjsp-request-search-invalid"); void input.offsetWidth;
        input.classList.add("tjsp-request-search-invalid");
        window.setTimeout(function () { input.classList.remove("tjsp-request-search-invalid"); }, 450);
    }

    function abrirChamadoPorPesquisa() {
        var input = document.getElementById("tjsp-request-search-input"), numeroChamado = sanitizarNumeroChamado(input ? input.value : "");
        if (!numeroChamado) { sinalizarPesquisaChamadoInvalida(input); return false; }
        if (input) { input.value = numeroChamado; }
        window.open(montarUrlChamado(numeroChamado), "_blank", "noopener,noreferrer");
        return true;
    }

    function criarPesquisaChamado() {
        var existente = document.getElementById("tjsp-request-search-widget"), wrapper, label, input, botao, icone;
        if (!deveMostrarPesquisaChamado()) { if (existente) { existente.remove(); } return; }
        if (existente) { return; }
        criarEstilo();
        wrapper = document.createElement("div"); wrapper.id = "tjsp-request-search-widget"; wrapper.setAttribute("aria-label", "Consulta rápida de solicitação por número");
        label = document.createElement("span"); label.className = "tjsp-request-search-label"; label.textContent = "Consulta rápida";
        input = document.createElement("input"); input.id = "tjsp-request-search-input"; input.type = "text"; input.inputMode = "numeric"; input.autocomplete = "off"; input.placeholder = "Nº do chamado"; input.maxLength = 12; input.setAttribute("aria-label", "Número do chamado"); input.setAttribute("pattern", "[0-9]*");
        botao = document.createElement("button"); botao.id = "tjsp-request-search-button"; botao.type = "button"; botao.title = "Abrir solicitação em nova guia"; botao.setAttribute("aria-label", "Abrir solicitação em nova guia");
        icone = document.createElement("span"); icone.className = "tjsp-request-search-icon";
        icone.innerHTML = ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<circle cx='10.8' cy='10.8' r='6.2' stroke-width='2'/>", "<path d='M15.4 15.4L20 20' stroke-width='2.3' stroke-linecap='round'/>", "</svg>"].join("");
        botao.appendChild(icone);
        input.addEventListener("input", function () { input.value = sanitizarNumeroChamado(input.value); });
        input.addEventListener("paste", function () { window.setTimeout(function () { input.value = sanitizarNumeroChamado(input.value); }, 0); });
        input.addEventListener("keydown", function (event) { if (event.key === "Enter") { event.preventDefault(); abrirChamadoPorPesquisa(); } });
        botao.addEventListener("click", function (event) { event.preventDefault(); abrirChamadoPorPesquisa(); });
        wrapper.appendChild(label); wrapper.appendChild(input); wrapper.appendChild(botao); document.body.appendChild(wrapper);
    }

    function faviconAzulDataUrl() {
        return "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='29' fill='#0078d4'/><circle cx='32' cy='32' r='20' fill='none' stroke='white' stroke-width='7'/></svg>");
    }

    function manterFaviconAzul() {
        var href = faviconAzulDataUrl();
        var links = document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon']");
        var link, i;
        for (i = 0; i < links.length; i++) { links[i].parentNode.removeChild(links[i]); }
        link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/svg+xml";
        link.href = href;
        document.head.appendChild(link);
    }

    function aplicarDestaqueGuiaConsultaRapida() {
        var tituloAtual, tituloLimpo, banner;
        if (location.hash.indexOf(HASH_DESTAQUE_ABERTURA) < 0) { return; }

        tituloAtual = document.title || "Solicitação";
        tituloLimpo = tituloAtual.replace(/^🔵\s*/g, "");
        if (tituloAtual.indexOf(TITULO_PREFIXO_CONSULTA) !== 0) {
            document.title = TITULO_PREFIXO_CONSULTA + tituloLimpo;
        }

        manterFaviconAzul();
        document.body.classList.add("tjsp-opened-tab-highlight-body");

        banner = document.getElementById("tjsp-opened-tab-highlight-banner");
        if (!banner && document.body) {
            banner = document.createElement("div");
            banner.id = "tjsp-opened-tab-highlight-banner";
            banner.innerHTML = "<strong>Consulta rápida</strong> — solicitação aberta por pesquisa rápida";
            document.body.appendChild(banner);
        }
    }

    function destacarGuiaAbertaPelaPesquisa() {
        if (location.hash.indexOf(HASH_DESTAQUE_ABERTURA) < 0) { return; }
        aplicarDestaqueGuiaConsultaRapida();
        if (!intervaloDestaqueGuia) {
            intervaloDestaqueGuia = window.setInterval(aplicarDestaqueGuiaConsultaRapida, 700);
        }
    }

    function aguardarEditorDiscussao() { return waitForCondition(function () { return !!localizarEditorDiscussao(); }, 15000, 300); }

    function configurarParaEObjetivo() {
        var selectPara, selectObjetivo, resultadoPara = false, resultadoObjetivo = false;
        if (!estaNaAbaDiscussoes()) { return Promise.resolve({ para: false, objetivo: false }); }
        return aguardarEditorDiscussao().then(function (ok) {
            if (!ok) { return { para: false, objetivo: false }; }
            selectPara = localizarSelectPara(); selectObjetivo = localizarSelectObjetivo();
            if (selectPara) { resultadoPara = selecionarSelectNativo(selectPara, VALOR_PARA_USUARIO); }
            return sleep(500).then(function () {
                if (selectObjetivo) { resultadoObjetivo = selecionarSelectNativo(selectObjetivo, VALOR_OBJETIVO_ATUALIZACAO); }
                return sleep(500).then(function () { return { para: resultadoPara, objetivo: resultadoObjetivo }; });
            });
        });
    }

    function preencherEditorDiscussao() {
        var editor, textoHtml, nome, instance, editable;
        if (!estaNaAbaDiscussoes()) { return false; }
        editor = localizarEditorDiscussao(); if (!editor) { return false; }
        textoHtml = montarTextoPadrao().textoHtml;
        editor.focus(); editor.innerHTML = textoHtml; dispararEventos(editor);
        try {
            if (window.CKEDITOR && window.CKEDITOR.instances) {
                for (nome in window.CKEDITOR.instances) {
                    if (Object.prototype.hasOwnProperty.call(window.CKEDITOR.instances, nome)) {
                        instance = window.CKEDITOR.instances[nome]; editable = instance.editable && instance.editable();
                        if (editable && editable.$ === editor) { instance.setData(textoHtml); instance.fire("change"); break; }
                    }
                }
            }
        } catch (e) {}
        return true;
    }

    function irParaGeral() { var url; if (estaNaAbaGeral()) { return true; } url = gerarUrlGeral(); if (!url) { return false; } location.href = url; return false; }
    function irParaDiscussoes() { var url; if (estaNaAbaDiscussoes()) { return true; } url = gerarUrlDiscussoes(); if (!url) { return false; } location.href = url; return false; }
    function garantirAbaDiscussoesAberta() { var url; if (estaNaAbaDiscussoes()) { return true; } url = gerarUrlDiscussoes(); if (url) { location.href = url; return false; } return false; }

    function etapaCapturarNomeNaGeral() {
        if (!irParaGeral()) { return Promise.resolve(false); }
        return waitForCondition(function () { var campo = document.querySelector("input[name='Usuario_c'], input[id$='_Usuario_c']"); return campo && campo.value && campo.value.trim(); }, 12000, 300).then(function () {
            var primeiroNome = obterPrimeiroNomeUsuarioNaGeral();
            if (primeiroNome) { sessionStorage.setItem(STORAGE_PRIMEIRO_NOME, primeiroNome); } else { sessionStorage.removeItem(STORAGE_PRIMEIRO_NOME); }
            sessionStorage.setItem(STORAGE_ETAPA, ETAPA_EXECUTAR_NA_DISCUSSAO); irParaDiscussoes(); return true;
        });
    }

    function etapaExecutarNaDiscussao() {
        if (!irParaDiscussoes()) { return Promise.resolve(false); }
        return waitForCondition(function () { return document.querySelector("#tab-8.active") || location.href.toLowerCase().indexOf("/discussions") >= 0; }, 12000, 300).then(function () { return aguardarEditorDiscussao(); }).then(function (editorOk) {
            if (!editorOk) { sessionStorage.removeItem(STORAGE_ETAPA); alert(["Nao encontrei o editor da aba Discussoes.", "", "O script nao clicou em Iniciar discussao por seguranca.", "", "Abra manualmente a area de comentario, se necessario, e clique novamente no robo."].join("\n")); garantirAbaDiscussoesAberta(); return false; }
            return waitForCondition(function () { return localizarSelectPara() && localizarSelectObjetivo() && localizarEditorDiscussao(); }, 12000, 300);
        }).then(function (camposOk) {
            if (!camposOk) { sessionStorage.removeItem(STORAGE_ETAPA); alert(["Nao encontrei todos os campos da aba Discussoes.", "", "Verifique se os campos Para, Objetivo e o editor de texto estao visiveis."].join("\n")); garantirAbaDiscussoesAberta(); return false; }
            sessionStorage.removeItem(STORAGE_ETAPA);
            return configurarParaEObjetivo().then(function (resultadoCampos) {
                var resultadoTexto = preencherEditorDiscussao(), primeiroNomeUsado = sessionStorage.getItem(STORAGE_PRIMEIRO_NOME) || "", mensagens = [];
                mensagens.push(resultadoCampos.para ? "Campo Para ajustado para Usuario." : "Nao consegui ajustar automaticamente o campo Para.");
                mensagens.push(resultadoCampos.objetivo ? "Campo Objetivo ajustado para Atualizacao de status." : "Nao consegui ajustar automaticamente o campo Objetivo.");
                mensagens.push(resultadoTexto ? "Texto inserido no editor da discussao." : "Nao consegui encontrar ou preencher o editor de texto.");
                mensagens.push(primeiroNomeUsado ? "Usuario capturado na aba Geral: " + primeiroNomeUsado + "." : "Nao consegui identificar o usuario na aba Geral. Usei saudacao generica.");
                alert(["Automacao concluida.", "", mensagens.join("\n"), "", "A aba Discussoes permanecera aberta para conferencia manual antes de enviar ou adicionar."].join("\n")); garantirAbaDiscussoesAberta(); return true;
            });
        });
    }

    function continuarFluxoPendente() {
        var etapa;
        if (fluxoEmAndamento) { return; }
        etapa = sessionStorage.getItem(STORAGE_ETAPA); if (!etapa) { return; }
        fluxoEmAndamento = true;
        sleep(1200).then(function () {
            if (etapa === ETAPA_CAPTURAR_NOME_NA_GERAL) { return etapaCapturarNomeNaGeral(); }
            if (etapa === ETAPA_EXECUTAR_NA_DISCUSSAO) { return etapaExecutarNaDiscussao(); }
            return false;
        }).catch(function (erro) { console.error("[TJSP] Erro no fluxo pendente:", erro); alert("Ocorreu um erro durante a automacao. Veja o Console para detalhes."); sessionStorage.removeItem(STORAGE_ETAPA); }).then(function () { fluxoEmAndamento = false; });
    }

    function iniciarFluxoCompleto() {
        if (fluxoEmAndamento) { return; }
        fluxoEmAndamento = true;
        sessionStorage.removeItem(STORAGE_PRIMEIRO_NOME); sessionStorage.setItem(STORAGE_ETAPA, ETAPA_CAPTURAR_NOME_NA_GERAL);
        etapaCapturarNomeNaGeral().catch(function (erro) { console.error("[TJSP] Erro ao iniciar fluxo:", erro); alert("Ocorreu um erro ao iniciar a automacao. Veja o Console para detalhes."); sessionStorage.removeItem(STORAGE_ETAPA); }).then(function () { fluxoEmAndamento = false; });
    }

    function criarEstilo() {
        var style;
        if (document.getElementById("tjsp-auto-robot-style")) { return; }
        style = document.createElement("style"); style.id = "tjsp-auto-robot-style";
        style.textContent = [
            "#tjsp-auto-robot-widget{position:fixed;top:76px;right:24px;z-index:999999;font-family:Arial,sans-serif}",
            "#tjsp-auto-robot-button{width:52px;height:52px;border-radius:50%;border:0;background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff;font-size:27px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center}",
            "#tjsp-auto-robot-button:hover{background:linear-gradient(135deg,#004578,#005a9e);transform:scale(1.06)}",
            "#tjsp-auto-options-menu{position:absolute;top:62px;right:0;min-width:260px;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.22);overflow:hidden}",
            "#tjsp-auto-options-menu.tjsp-auto-hidden{display:none}",
            ".tjsp-auto-menu-header{padding:10px 13px;font-size:13px;font-weight:700;color:#333;background:#f5f7fa;border-bottom:1px solid #e5e7eb}",
            ".tjsp-auto-menu-option{width:100%;border:0;background:#fff;padding:12px 14px;text-align:left;font-size:13px;color:#222;cursor:pointer;display:flex;align-items:center;gap:8px}",
            ".tjsp-auto-menu-option:hover{background:#eef6ff;color:#005a9e}",
            ".tjsp-auto-menu-option-icon{font-size:16px}",
            "#tjsp-request-search-widget{position:fixed;top:7px;right:385px;z-index:1000000;height:42px;display:flex;align-items:center;gap:8px;padding:5px 7px 5px 12px;border:1px solid rgba(255,255,255,.42);border-radius:14px;background:linear-gradient(135deg,#005a9e,#0078d4 58%,#00a2ed);box-shadow:0 5px 16px rgba(0,60,110,.32),inset 0 1px 0 rgba(255,255,255,.36);font-family:Arial,sans-serif;box-sizing:border-box}",
            "#tjsp-request-search-widget:before{content:'';position:absolute;inset:1px;border-radius:13px;border:1px solid rgba(255,255,255,.20);pointer-events:none}",
            "#tjsp-request-search-widget .tjsp-request-search-label{font-size:12px;font-weight:700;color:#fff;white-space:nowrap;letter-spacing:.01em;text-shadow:0 1px 1px rgba(0,0,0,.24)}",
            "#tjsp-request-search-input{width:130px;height:30px;border:1px solid rgba(255,255,255,.72);border-radius:9px;padding:0 10px;font-size:13px;color:#123;background:rgba(255,255,255,.96);outline:none;box-sizing:border-box;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}",
            "#tjsp-request-search-input:focus{border-color:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.28),0 0 0 5px rgba(0,120,212,.22);background:#fff}",
            "#tjsp-request-search-input::placeholder{color:#6b7785}",
            "#tjsp-request-search-button{width:32px;height:32px;min-width:32px;border:1px solid rgba(255,255,255,.60);border-radius:10px;background:linear-gradient(135deg,#003f75,#0067b8);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 7px rgba(0,50,100,.35),inset 0 1px 0 rgba(255,255,255,.35);transition:filter .15s ease,box-shadow .15s ease,transform .10s ease;box-sizing:border-box}",
            "#tjsp-request-search-button:hover{filter:saturate(1.18) brightness(1.12);box-shadow:0 3px 10px rgba(0,50,100,.45),inset 0 1px 0 rgba(255,255,255,.45);transform:translateY(-1px)}",
            "#tjsp-request-search-button:active{transform:translateY(0);box-shadow:0 1px 3px rgba(0,50,100,.35),inset 0 1px 2px rgba(0,0,0,.18)}",
            "#tjsp-request-search-button svg{width:17px;height:17px;display:block;stroke:#fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}",
            "#tjsp-request-search-input.tjsp-request-search-invalid{border-color:#ffdad6!important;box-shadow:0 0 0 3px rgba(255,255,255,.25),0 0 0 5px rgba(201,42,42,.25)!important;animation:tjspRequestSearchShake .28s ease-in-out}",
            "@keyframes tjspRequestSearchShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}",
            "#tjsp-opened-tab-highlight-banner{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:1000000;background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff;border:1px solid rgba(255,255,255,.42);border-radius:999px;padding:9px 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(0,90,158,.36)}",
            "body.tjsp-opened-tab-highlight-body:after{content:'';position:fixed;inset:0;z-index:999997;border:4px solid #0078d4;box-shadow:inset 0 0 0 2px rgba(255,255,255,.7),inset 0 0 30px rgba(0,120,212,.22);pointer-events:none}",
            "@media(max-width:1200px){#tjsp-request-search-widget{right:260px}#tjsp-request-search-widget .tjsp-request-search-label{display:none}#tjsp-request-search-input{width:118px}}",
            ".tjsp-editor-toolbar-group{display:inline-flex!important;align-items:center!important;gap:6px!important;margin-left:9px!important;padding-left:9px!important;border-left:1px solid #b8c7d8!important;vertical-align:middle!important;height:30px!important}",
            ".tjsp-editor-toolbar-btn{width:30px!important;height:30px!important;min-width:30px!important;min-height:30px!important;padding:0!important;border:1px solid #005a9e!important;border-radius:8px!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:0 2px 6px rgba(0,90,158,.35),inset 0 1px 0 rgba(255,255,255,.35)!important;transition:filter .15s ease,box-shadow .15s ease,transform .10s ease!important;position:relative!important;overflow:hidden!important;opacity:1!important;filter:none!important;box-sizing:border-box!important}",
            ".tjsp-editor-toolbar-btn svg{width:18px!important;height:18px!important;display:block!important;stroke:#fff!important;stroke-width:2!important;filter:drop-shadow(0 1px 1px rgba(0,0,0,.28))!important;opacity:1!important}",
            ".tjsp-editor-toolbar-btn:hover{filter:saturate(1.18) brightness(1.10)!important;box-shadow:0 3px 10px rgba(0,90,158,.45),inset 0 1px 0 rgba(255,255,255,.45)!important;transform:translateY(-1px)!important}",
            ".tjsp-editor-toolbar-btn:active{transform:translateY(0)!important;box-shadow:0 1px 3px rgba(0,50,100,.35),inset 0 1px 2px rgba(0,0,0,.18)!important}",
            ".tjsp-editor-btn-assinar{background:linear-gradient(135deg,#005a9e,#0078d4)!important}",
            ".tjsp-editor-btn-imagens{background:linear-gradient(135deg,#004b8d,#00a2ed)!important}",
            ".cke_image_resizer,.cke_widget_drag_handler_container,[data-cke-widget-resizer],.cke_widget_wrapper .cke_image_resizer,.cke_widget_selected .cke_image_resizer{display:none!important;visibility:hidden!important;opacity:0!important;width:0!important;height:0!important;border:0!important;padding:0!important;margin:0!important}"
        ].join("\n");
        document.head.appendChild(style);
    }

    function criarOpcao(id, iconeHtml, texto, callback) {
        var btn = document.createElement("button"); btn.id = id; btn.type = "button"; btn.className = "tjsp-auto-menu-option";
        btn.innerHTML = "<span class='tjsp-auto-menu-option-icon'>" + iconeHtml + "</span><span>" + texto + "</span>";
        btn.addEventListener("click", function (event) { event.stopPropagation(); var menu = document.getElementById("tjsp-auto-options-menu"); if (menu) { menu.classList.add("tjsp-auto-hidden"); } callback(); });
        return btn;
    }

    function criarBotao() {
        var widgetExistente, botaoAntigo, wrapperAntigo, widget, botaoRobo, menu, cabecalho;
        if (!estaEmTelaDeChamado()) { widgetExistente = document.getElementById("tjsp-auto-robot-widget"); if (widgetExistente) { widgetExistente.remove(); } return; }
        if (document.getElementById("tjsp-auto-robot-widget")) { return; }
        botaoAntigo = document.getElementById("btn-tjsp-informar-recebimento"); if (botaoAntigo) { wrapperAntigo = botaoAntigo.closest("#wrapper-tjsp-informar-recebimento") || botaoAntigo; wrapperAntigo.remove(); }
        criarEstilo(); widget = document.createElement("div"); widget.id = "tjsp-auto-robot-widget";
        botaoRobo = document.createElement("button"); botaoRobo.id = "tjsp-auto-robot-button"; botaoRobo.type = "button"; botaoRobo.textContent = "🤖"; botaoRobo.title = "Exibir opcoes automatizadas"; botaoRobo.setAttribute("aria-label", "Exibir opcoes automatizadas");
        menu = document.createElement("div"); menu.id = "tjsp-auto-options-menu"; menu.className = "tjsp-auto-hidden";
        cabecalho = document.createElement("div"); cabecalho.className = "tjsp-auto-menu-header"; cabecalho.textContent = "Opcoes automatizadas"; menu.appendChild(cabecalho);
        menu.appendChild(criarOpcao("tjsp-auto-option-informar-recebimento", "📨", "Informar recebimento do chamado", iniciarFluxoCompleto));
        botaoRobo.addEventListener("click", function (event) { event.stopPropagation(); menu.classList.toggle("tjsp-auto-hidden"); });
        document.addEventListener("click", function (event) { if (!widget.contains(event.target)) { menu.classList.add("tjsp-auto-hidden"); } });
        widget.appendChild(botaoRobo); widget.appendChild(menu); document.body.appendChild(widget);
    }

    function iniciar() {
        var observer;
        criarEstilo(); criarBotao(); criarPesquisaChamado(); instalarBotoesEditores(); destacarGuiaAbertaPelaPesquisa();
        observer = new MutationObserver(function () { criarBotao(); criarPesquisaChamado(); instalarBotoesEditores(); continuarFluxoPendente(); destacarGuiaAbertaPelaPesquisa(); });
        observer.observe(document.body, { childList: true, subtree: true });
        continuarFluxoPendente();
        console.log("[TJSP] Robo de automacoes carregado. Versao 1.8.15.");
    }

    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", iniciar); } else { iniciar(); }
}());
