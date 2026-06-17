const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const FormData = require('form-data');

// ==========================================
// 1. CONFIGURAÇÕES, CONSTANTES E ESTADOS
// ==========================================
const URL_RAILWAY = "https://veritas-production-ba3a.up.railway.app/v3/predict/heatmap";
const SAUDACOES = ["oi", "olá", "ola", "oii", "oiii", "hey", "oi!", "olá!"];

// Definição dos estados possíveis da conversa
const ESTADOS = {
    INICIO: 'INICIO',
    AGUARDANDO_IMAGEM: 'AGUARDANDO_IMAGEM',
    AGUARDANDO_AVALIACAO: 'AGUARDANDO_AVALIACAO',
    AGUARDANDO_DECISAO_REPETIR: 'AGUARDANDO_DECISAO_REPETIR'
};

// Mapa em memória para guardar o estado de cada usuário (Chave: número do zap, Valor: estado)
const userSessions = new Map();

// ==========================================
// 2. SERVIÇOS EXTERNOS (API)
// ==========================================
async function analisarImagemNaAPI(imageBuffer) {
    const form = new FormData();
    form.append('file', imageBuffer, { filename: 'imagem.jpg', contentType: 'image/jpeg' });

    const response = await axios.post(URL_RAILWAY, form, {
        headers: { ...form.getHeaders() },
        timeout: 60000 
    });

    return {
        prediction: response.data.prediction,
        heatmapB64: response.data.heatmap
    };
}

// ==========================================
// 3. CONTROLADORES DE FLUXO (State Machine)
// ==========================================

/**
 * Estado Inicial: O usuário acabou de chegar ou mandou um "Oi" fora do fluxo.
 */
async function processarEstadoInicio(message, userId) {
    const texto = message.body.trim().toLowerCase();
    
    if (SAUDACOES.includes(texto)) {
        await message.reply("Olá, tudo bem!? Por favor, envie uma foto para a gente analisar :)");
        userSessions.set(userId, { estado: ESTADOS.AGUARDANDO_IMAGEM });
    } else {
        await message.reply("Olá! Digite *Oi* para iniciar uma nova análise de imagem. 📸");
    }
}

/**
 * Estado: O bot pediu uma imagem e está aguardando o envio.
 */
async function processarAguardandoImagem(message, userId, client) {
    // Se o usuário mandar texto em vez de imagem
    if (message.type !== 'image') {
        await message.reply("Por favor, envie uma imagem para eu analisar. 📸");
        return;
    }

    await message.reply("Imagem recebida! Analisando... ⏳");

    try {
        const media = await message.downloadMedia();
        const imageBuffer = Buffer.from(media.data, 'base64');

        const { prediction, heatmapB64 } = await analisarImagemNaAPI(imageBuffer);

        // Envia os resultados da IA
        const resultado = ((1 - prediction) * 100).toFixed(2).replace('.', ',');
        await message.reply(`✅ Análise concluída!\n\n📊 Resultado: *${resultado}% de chance de possuir manipulação.*\n\nAbaixo está o heatmap gerado:`);
        const heatmapMedia = new MessageMedia('image/jpeg', heatmapB64, 'heatmap.jpg');
        await client.sendMessage(message.from, heatmapMedia, { caption: "Heatmap gerado pela análise" });

        // AVANÇA O FLUXO: Pede a avaliação de 0 a 5
        setTimeout(async () => {
            await client.sendMessage(message.from, "De 0 a 5, como você avalia sua experiência com o Veritas?");
            userSessions.set(userId, { estado: ESTADOS.AGUARDANDO_AVALIACAO });
        }, 1500); // Pequeno delay de 1.5s para não enviar tudo colado

    } catch (error) {
        console.error("[ERRO API] Falha na integração:", error.message);
        await message.reply("❌ Ocorreu um erro ao processar a imagem no servidor. Digite *Oi* para tentar novamente.");
        userSessions.delete(userId); // Reseta o estado em caso de erro crítico
    }
}

/**
 * Estado: O bot está esperando uma nota de 0 a 5.
 */
async function processarAguardandoAvaliacao(message, userId, client) {
    const texto = message.body.trim();
    const nota = parseInt(texto);

    // Valida se o usuário digitou um número válido entre 0 e 5
    if (isNaN(nota) || nota < 0 || nota > 5) {
        await message.reply("Por favor, responda apenas com um número de *0 a 5*. ⭐");
        return;
    }

    console.log(`[AVALIAÇÃO] Usuário ${userId} deu nota: ${nota}`);
    // DICA: Aqui no futuro você pode salvar essa nota em um banco de dados ou planilha!

    // AVANÇA O FLUXO: Pergunta se quer enviar outra imagem
    await message.reply("Obrigado pelo seu feedback! ❤️\n\nGostaria de enviar outra imagem para análise?\n\n1️⃣ - Sim\n2️⃣ - Não");
    userSessions.set(userId, { estado: ESTADOS.AGUARDANDO_DECISAO_REPETIR, notaDigitada: nota });
}

/**
 * Estado: O bot quer saber se o usuário deseja repetir ou encerrar.
 */
async function processarAguardandoDecisaoRepetir(message, userId) {
    const texto = message.body.trim().toLowerCase();

    const respostasSim = ["sim", "s", "1", "quero", "yes"];
    const respostasNao = ["não", "nao", "n", "2", "no", "sair"];

    if (respostasSim.includes(texto)) {
        await message.reply("Perfeito! Pode enviar a próxima foto que eu já estou pronto. 📸");
        // Volta o estado para aguardar a imagem novamente
        userSessions.set(userId, { estado: ESTADOS.AGUARDANDO_IMAGEM });
    } 
    else if (respostasNao.includes(texto)) {
        await message.reply("Tá certo, estamos encerrando essa conversa. Obrigado por usar o Veritas! 🛡️\n\nDigite *Oi* a qualquer momento para iniciar um novo fluxo.");
        // Remove o usuário do mapa, limpando a memória e resetando ele pro início
        userSessions.delete(userId);
    } 
    else {
        await message.reply("Desculpe, não entendi. Por favor, responda com *Sim* ou *Não* (ou digite *1* para Sim e *2* para Não).");
    }
}

// ==========================================
// 4. INICIALIZAÇÃO E ROTEAMENTO (Router)
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/session' }),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

client.on('qr', (qr) => {
    const qrImageLink = `https://quickchart.io/qr?text=${encodeURIComponent(qr)}&size=400`;
    console.log('📌 Link do QR Code atualizado:\n', qrImageLink);
});

client.on('ready', () => console.log('✅ Bot conectado e com fluxo de estados ativado!'));

client.on('message', async (message) => {
    if (message.isStatus || message.from.includes('@g.us')) return;

    const userId = message.from; // Identificador único do usuário (número do celular)
    
    // Se o usuário não tem estado salvo, ele começa no INICIO
    if (!userSessions.has(userId)) {
        userSessions.set(userId, { estado: ESTADOS.INICIO });
    }

    const sessaoUsuario = userSessions.get(userId);

    // ROTEADOR DE ESTADOS: Direciona a mensagem para a função certa baseada no histórico
    switch (sessaoUsuario.estado) {
        case ESTADOS.INICIO:
            await processarEstadoInicio(message, userId);
            break;
            
        case ESTADOS.AGUARDANDO_IMAGEM:
            await processarAguardandoImagem(message, userId, client);
            break;
            
        case ESTADOS.AGUARDANDO_AVALIACAO:
            await processarAguardandoAvaliacao(message, userId, client);
            break;
            
        case ESTADOS.AGUARDANDO_DECISAO_REPETIR:
            await processarAguardandoDecisaoRepetir(message, userId);
            break;
            
        default:
            await processarEstadoInicio(message, userId);
            break;
    }
});

client.initialize();