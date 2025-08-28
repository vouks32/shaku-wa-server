import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "baileys"
import { Boom } from "@hapi/boom"
import QRCode from 'qrcode'
import { handlers_arr } from "./handlers.js"

const getFooter = "\n\n_Shaku Mining Bot 🤖_"

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info")
    const sock = makeWASocket({
        auth: state,
        markOnlineOnConnect: false
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log("connection closed due to ", lastDisconnect?.error, ", reconnecting ", shouldReconnect)

            if (shouldReconnect) startBot()
        } else if (connection === "open") {
            console.log("✅ Bot is online!")
        }

        if (qr) {
            console.log(await QRCode.toString(qr, { type: 'terminal' }))
        }
    })


    // Handlers storage
    const handlers = {
        commands: new Map(),   // command -> callback
        text: [],              // regex -> callback
        any: [],               // callback
    }

    // Register handlers API
    function registerHandlers(whatsapp) {
        whatsapp.onCommand = (cmd, fn) => {
            handlers.commands.set(cmd.toLowerCase(), fn)
        }
        whatsapp.onText = (regex, fn) => {
            handlers.text.push({ regex, fn })
        }
        whatsapp.onAny = (fn) => {
            handlers.any.push(fn)
        }
    }

    // Handle messages
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0]
        if (!msg.message || msg.key.fromMe) return

        const sender = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""

        // Build reusable whatsapp object
        const whatsapp = {
            sender,
            text,
            raw: msg,

            reply: async (message) => {
                await sock.sendMessage(sender, { text: message }, { quoted: msg })
            },

            sendMessage: async (jid, message) => {
                await sock.sendMessage(jid, { text: message })
            },

            sendImage: async (jid, buffer, caption = "") => {
                await sock.sendMessage(jid, { image: buffer, caption })
            },

            sendAudio: async (jid, buffer, ptt = false) => {
                await sock.sendMessage(jid, { audio: buffer, mimetype: "audio/mp4", ptt })
            },

            sendVideo: async (jid, buffer, caption = "") => {
                await sock.sendMessage(jid, { video: buffer, caption })
            },

            sendButtons: async (jid, text, footer, buttons) => {
                const buttonMsg = {
                    text,
                    footer,
                    buttons: buttons.map((btn, i) => ({
                        buttonId: btn.id || `btn-${i}`,
                        buttonText: { displayText: btn.text },
                        type: 1,
                    })),
                    headerType: 1,
                }
                await sock.sendMessage(jid, buttonMsg)
            },

            sendList: async (jid, text, footer, title, buttonText, sections) => {
                const listMessage = {
                    text,
                    footer,
                    title,
                    buttonText,
                    sections: sections.map((section) => ({
                        title: section.title,
                        rows: section.rows.map((row) => ({
                            title: row.title,
                            description: row.description,
                            rowId: row.id,
                        })),
                    })),
                }
                await sock.sendMessage(jid, listMessage)
            },

            sendTemplate: async (jid, text, buttons) => {
                const templateMessage = {
                    text,
                    footer: "Powered by your bot",
                    templateButtons: buttons.map((btn, i) => {
                        if (btn.type === "url") {
                            return { index: i + 1, urlButton: { displayText: btn.text, url: btn.url } }
                        } else if (btn.type === "call") {
                            return { index: i + 1, callButton: { displayText: btn.text, phoneNumber: btn.number } }
                        } else {
                            return { index: i + 1, quickReplyButton: { displayText: btn.text, id: btn.id } }
                        }
                    }),
                }
                await sock.sendMessage(jid, templateMessage)
            },
        }

        // Attach middleware methods
        registerHandlers(whatsapp)

        // Dispatch logic
        let handled = false

        // Command match (exact)
        if (handlers.commands.has(text.toLowerCase())) {
            await handlers.commands.get(text.toLowerCase())(whatsapp)
            handled = true
        }

        // Regex/text match
        for (const { regex, fn } of handlers.text) {
            if (regex.test(text)) {
                await fn(whatsapp)
                handled = true
            }
        }

        // Fallback "any" handlers
        if (!handled) {
            for (const fn of handlers.any) {
                await fn(whatsapp)
            }
        }
    })

    const sendTheMenu = async (whatsapp, quote = true) => {
        let text = "Salut, je suis le *Shaku Mining bot🤖.*\n\nEnvoyez moi le chiffre qui correspond à votre question:\n\n" +
            handlers_arr.map(_h => "[" + _h.number + "] - *" + _h.text + "*").join('\n') + getFooter;
       if(quote)
            await whatsapp.reply(text)
        else
            await whatsapp.sendMessage(whatsapp.sender, text)
    }

    // --- Register your handlers ---
    // Example: command handler
    handlers.commands.set("menu", async (whatsapp) => {
        await sendTheMenu(whatsapp)
    })

    handlers_arr.forEach((_h) => {
        handlers.commands.set(_h.number, async (whatsapp) => {
            await whatsapp.reply(_h.response)
            await sendTheMenu(whatsapp, false)
        })
    })

    // Example: regex handler
    handlers.text.push({
        regex: /hi|hello|salut|bonjour/i,
        fn: async (whatsapp) => {
            await whatsapp.reply("👋 Salut!")
            await sendTheMenu(whatsapp, false)
        },
    })

    // Example: any handler
    handlers.any.push(async (whatsapp) => {
        console.log(`📩 [${whatsapp.sender}] ${whatsapp.text}`)
        if (!whatsapp.text.toLowerCase().startsWith("menu")) {
            await sendTheMenu(whatsapp)
        }
    })
}

startBot()
