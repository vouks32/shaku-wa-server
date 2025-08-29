import { makeWASocket, useMultiFileAuthState, DisconnectReason, extractImageThumb } from "baileys"
import QRCode from 'qrcode'
import { makeRetryHandler } from "./handler.js";
import sharp from "sharp";
import fs from "fs-extra"
import NodeCache from "node-cache";


const handler = makeRetryHandler();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

const contactFile = 'ContactsPerCountry.json'
const contacts = fs.readJSONSync(contactFile)

const message = (name) => {
    return "Cher *" + name.trim() + "*,\n\n" +
        "Ici le service client de *Shaku Mining LTD*\n" +
        "*CR-75ADE664 – Registrar of Companies (Companies and Other Business Entities Act [Chapter 24:31])*\n\n" +
        "J'ai Le plaisir de vous annoncer la création de notre plate-forme en ligne d'investissement minier en Afrique.\n\n" +
        "https://Shaku-mining.vercel.app/info\n\n" +
        "Sur cette plate-forme, vous avez la possibilité d'investir dans nos différents actifs minier[Or, Diamand, Cobalt, etc...] et recevoir des dividendes par jour allant jusqu'à *1000% de retours sur investissement*\n\n" +
        "En quelques clics, créez un compte, validez votre identité, investissez et *recevez des profits chaque jours*\n\n" +
        "https://Shaku-mining.vercel.app/info est une plate-forme facile d'utilisation offrant des moyens de paiement sécurisés (Carte de crédit, Mobile Money, et bientôt Paypal)\n\n" +
        "Notre communauté d'investisseurs compte déjà plus de 100,000 membres partout en Afrique, et nous serions ravis de vous compter parmi eux.\n\n" +
        "> Shaku Mining LTD\n\n"
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function optimizeGifSharp(gifPath, id) {
    return await sharp(gifPath)
        .resize({ width: 800 }) // Resize to 500px width
        .jpeg({ quality: 100 }).toBuffer();
}

function htmlDecode(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("../shaku_auth_info")
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

    const sock = makeWASocket({
        auth: state,
        markOnlineOnConnect: true,
        getMessage: handler.getHandler,
        cachedGroupMetadata: async (jid) => groupCache.get(jid)
    })

    sock.ev.on("creds.update", saveCreds)
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log("connection closed due to ", lastDisconnect?.error, ", reconnecting ", shouldReconnect)

            startBot()
        } else if (connection === "open") {
            console.log("✅ Bot is online!")
        }

        if (qr) {
            console.log(await QRCode.toString(qr, { type: 'terminal' }))
        }
    })
    sock.ev.on('groups.update', async ([event]) => {
        const metadata = await sock.groupMetadata(event.id)
        groupCache.set(event.id, metadata)
    })
    sock.ev.on('group-participants.update', async (event) => {
        const metadata = await sock.groupMetadata(event.id)
        groupCache.set(event.id, metadata)
    })
    // Handle messages
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0]


        if (!msg.message || msg.key.fromMe) {
            return
        }
        // Parse the message to get type and JIDs
        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const senderJid = isGroup ? (msg.key?.participant?.endsWith('@lid') && msg.key?.number ? msg.key?.number : msg.key?.participant) : remoteJid;
        const sender = senderJid

        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";

        const whatsapp = {
            isGroup,
            remoteJid,
            senderJid,
            sender,
            text,
            raw: msg,

            reply: async (message, mentions = undefined) => {
                await sock.sendMessage(remoteJid, { text: htmlDecode(message) + (message.length > 300 ? '\n\n𝐯𝐨𝐮𝐤𝐬 𝐛𝐨𝐭' : ""), mentions: mentions }, { quoted: msg }).then(handler.addMessage)
            },

            sendMessage: async (jid, message, mentions = undefined) => {
                await sock.sendMessage(jid, { text: htmlDecode(message) + (message.length > 300 ? '\n\n𝐯𝐨𝐮𝐤𝐬 𝐛𝐨𝐭' : ""), mentions: mentions }).then(handler.addMessage)
            },

            sendImage: async (jid, buffer, caption = "", mentions = []) => {
                if (buffer.includes('http')) {
                    await sock.sendMessage(jid, { image: { url: buffer }, caption: htmlDecode(caption), mentions }).then(handler.addMessage)
                    return
                }
                const imagename = buffer.split('/').pop()
                let optimizedImage = (await optimizeGifSharp(buffer, './images/send/opt-' + imagename))
                const t = await extractImageThumb(optimizedImage)
                await sock.sendMessage(jid, { image: optimizedImage, jpegThumbnail: t.buffer, caption: htmlDecode(caption), mentions }).then(handler.addMessage)
            },
        }

        // Attach middleware methods
        registerHandlers(whatsapp)


        // Dispatch logic
        let handled = false


        try {

            // Command match (exact)
            if (handlers.commands.has(text.toLowerCase())) {
                await handlers.commands.get(text.toLowerCase())(whatsapp)
                handled = true
            }

            // Regex/text match
            for (const { regex, fn } of handlers.text) {
                if (regex.test(text.toLowerCase())) {
                    await fn(whatsapp)
                    handled = true
                }
            }

            // Fallback "any" handlers
            if (!handled) {
                for (const fn of handlers.any) {
                    await fn(whatsapp)
                    handled = true
                }
            }


            if (handled) {
                //console.log(whatsapp.senderJid, ":", whatsapp.raw.message?.videoMessage?.contextInfo)
                console.log(whatsapp.senderJid, ":", whatsapp.raw.message?.videoMessage)
                /* */
                /*console.log("------------------------------")*/
            }
        } catch (error) {
            //await whatsapp.reply("Donc... ta commande m'a fait crasher😐\nVas savoir pourquoi... enfin bon, pas de panique, j'ai été programmé pour gérer ça")
            await whatsapp.sendMessage("237676073559@s.whatsapp.net", "Erreur négro \n\n" + error.toString() + '\nLe dernier Message :')
            await whatsapp.sendMessage("237676073559@s.whatsapp.net", "@" + whatsapp.sender.split('@')[0] + " : " + whatsapp.text, [whatsapp.sender])

            console.log(error)
        }

    })


    handlers.commands.set("!ggg", async (whatsapp) => {

    })

    // MENTION
    handlers.text.push({
        regex: /!send/,
        fn: async (whatsapp) => {

            const name = whatsapp.text.split(" ")[1].trim()
            const contactList = contacts[name]
            if (contactList) {
                await whatsapp.reply('Sending to: ' + contactList.length + ' people')

                let sendContact = []
                for (let i = 0; i < contactList.length; i++) {
                    const contact = contactList[i];
                    if (contact.wasSend || !contact.formattedPhone) continue;
                    if (name === "CM" && contact.formattedPhone.charAt(4) !== '6') contact.formattedPhone = '+2376' + contact.formattedPhone.slice(4)
                    await whatsapp.sendImage(contact.formattedPhone.replaceAll('+', '') + "@s.whatsapp.net", './flyer.jpg', message((contact.name || 'Investisseur')))
                    await whatsapp.sendMessage(contact.formattedPhone.replaceAll('+', '') + "@s.whatsapp.net", "https://shaku-mining.vercel.app/info")
                    //await whatsapp.sendMessage(contact.formattedPhone.replaceAll('+', '') + "@s.whatsapp.net", message(contact.name))
                    contacts[name][i].wasSend = true;
                    fs.outputJSONSync(contactFile, contacts)

                    console.log((i + 1) + " - Message send to ", contact.name, ":", contact.formattedPhone)

                    sendContact.push(contact)
                    if (i % 10 == 0 && i > 0) {
                        await whatsapp.reply('J\'ai envoyé à : \n' + sendContact.map(_contact => _contact.name + ' : ' + _contact.formattedPhone).join('\n'))
                        sendContact = []
                    }

                    await delay(4 * 60 * 1000)
                }

            } else {
                await whatsapp.reply('Existe pas negro: \n' + Object.keys(contacts).map(cc => `- ${cc}`).join('\n'))
            }

        }
    })

}

startBot()
