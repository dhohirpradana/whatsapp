import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, Browsers, delay, DisconnectReason, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import * as qrcode from 'qrcode';
const math = require('mathjs');

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

import { db } from './database'

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		browser: Browsers.macOS('Desktop'),
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
	})

	store?.bind(sock.ev)

	// send wss to the client if was logged in on whatsapp web
	if (sock.authState.creds.registered) {
		wssSession?.send(JSON.stringify({ type: 'auth', data: "logged in" }));
	}


	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		if (useMobile) {
			throw new Error('Cannot use pairing code with mobile api')
		}

		const phoneNumber = await question('Please enter your mobile phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	// If mobile was chosen, ask for the code
	if (useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if (!registration.phoneNumber) {
			registration.phoneNumber = await question('Please enter your mobile phone number:\n')
		}

		const libPhonenumber = await import("libphonenumber-js")
		const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
		if (!phoneNumber?.isValid()) {
			throw new Error('Invalid phone number: ' + registration!.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if (!mcc) {
			throw new Error('Could not find MCC for phone number: ' + registration!.phoneNumber + '\nPlease specify the MCC manually.')
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Please enter the one time code:\n')
				const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
				console.log('Successfully registered your phone number.')
				console.log(response)
				rl.close()
			} catch (error) {
				console.error('Failed to register your phone number. Please try again.\n', error)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

			open(path)
			const code = await question('Please enter the captcha code:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if (!registration.method) {
				let code = await question('How would you like to receive the one time code for registration? "sms" or "voice"\n')
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if (code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch (error) {
				console.error('Failed to request registration code. Please try again.\n', error)

				if (error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async (events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if (connection === 'close') {
					// reconnect if not logged out
					if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
						wssSession?.send(JSON.stringify({ type: 'auth', data: "Logged out" }));

						// clear bayleys_auth_info directory
						console.log('Clearing baileys_auth_info directory')
						fs.rmdirSync('./baileys_auth_info', { recursive: true });

						// relogin
						console.log('Relogging in')
						wssSession?.send(JSON.stringify({ type: 'auth', data: "Relogging in" }));
						startSock()
					}
				}

				console.log('connection update', update)
				// qr to base64
				if (update.qr) {
					qrcode.toDataURL(update.qr, (err, url) => {
						if (err) {
							console.error('error generating qr', err)
							return
						}
						wssSession?.send(JSON.stringify({ type: 'base64', data: url }))
					})
				}

				// if connection is connecting
				if (update.connection === 'connecting') {
					wssSession?.send(JSON.stringify({ type: 'auth', data: "Connecting" }));
				}

				// if the connection was opened
				if (update.connection === 'open') {
					wssSession?.send(JSON.stringify({ type: 'auth', data: "Logged in" }));
				}
			}

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
			}

			if (events['labels.association']) {
				console.log(events['labels.association'])
			}


			if (events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if (events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if (events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } = events['messaging-history.set']
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
			}

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (!msg.key.fromMe && doReplies) {
							// if message from group don't reply
							if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
								continue
							}
							// console.log('replying to', msg.key.remoteJid)
							await sock!.readMessages([msg.key])

							if (msg.message?.conversation?.startsWith('!!')) {
								// retrieve type script code from database
								db.get("SELECT * FROM code WHERE key = ?", [msg.message?.conversation?.toLowerCase()], (err, row) => {
									if (err) throw err;
									if (row) {
										eval(row.value);
									}
								});
							}

							if (msg.message?.conversation?.startsWith('!')) {
								// select from request_response table
								db.get("SELECT * FROM request_response WHERE key = ?", [msg.message?.conversation?.toLowerCase()], (err, row) => {
									if (err) throw err;
									if (row) {
										// send response
										sendMessageWTyping({ text: row.value }, msg.key.remoteJid!)
									}
								});
							}

							if (msg.message?.conversation?.startsWith('##')) {
								if (msg.message?.conversation?.toLowerCase().startsWith('##calc') || msg.message?.conversation?.startsWith('##hitung')) {
									const expression = msg.message?.conversation?.replace(/##calc/, '').replace(/##hitung/, '')
									if (expression) {
										console.log('evaluating', expression)
										try {
											const result = math.evaluate(expression, { precision: 14 }).toString()
											await sendMessageWTyping({ text: `${result}` }, msg.key.remoteJid!)
										} catch (error) {
											console.error('error evaluating', error)
											await sendMessageWTyping({ text: 'Invalid expression' }, msg.key.remoteJid!)
										}
									}
								}
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if (events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

				for (const { key, update } of events['messages.update']) {
					if (update.pollUpdates) {
						const pollCreation = await getMessage(key)
						if (pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if (events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if (events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if (events['presence.update']) {
				console.log(events['presence.update'])
			}

			if (events['chats.update']) {
				console.log(events['chats.update'])
			}

			if (events['contacts.update']) {
				for (const contact of events['contacts.update']) {
					if (typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if (events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}
// startSock()

// Websocket server
import * as WebSocket from 'ws';
import * as http from 'http';

let wssSession: WebSocket | null = null;

export function createWebSocketServer(): http.Server {
	const server = http.createServer();
	const wss = new WebSocket.Server({ server });

	wss.on('connection', (ws: WebSocket) => {
		ws.on('message', (message: string) => {
			const data = JSON.parse(message);
			const { key, value, type, code } = data;

			if (type === 'init') {
				wssSession = ws;
				startSock();
			}

			if (type === 'request_responses') {
				// get request_response from sqlite3
				db.all('SELECT * FROM request_response', (err, rows) => {
					if (err) {
						console.error('Error retrieving request response from the database:', err);
						ws.send('Error retrieving request response from the database');
					}
					console.log('Request response retrieved from the database', rows);
					ws.send(JSON.stringify(rows));
				});
			}

			if (type === 'request_response-add-update') {
				// validate data
				if (!key || !value) {
					ws.send('key or value is missing');
					return;
				}

				// keys must start with !
				if (!key.startsWith('!')) {
					ws.send('Key must start with !');
					return;
				}

				db.get('SELECT * FROM request_response WHERE key = ?', [key.toLowerCase()], (err: any, row: any) => {
					if (err) {
						console.error('Error checking if request response exists in the database:', err);
						ws.send('Error checking if request response exists in the database');
					}
					if (row) {
						// Update request response in the database
						db.run('UPDATE request_response SET value = ? WHERE key = ?', [value, key.toLowerCase()]);
						console.log('Request response updated in the database');
						ws.send('Request response updated in the database');
					} else {
						// Store request response in the database
						db.run('INSERT INTO request_response (key, value) VALUES (?, ?)', [key.toLowerCase(), value]);
						console.log('Request response stored in the database');
						ws.send('Request response stored in the database');
					}
				});
			}

			if (type === 'request_response-delete') {
				// validate data
				if (!key) {
					ws.send('key is missing');
					return;
				}

				db.get('SELECT * FROM request_response WHERE key = ?', [key.toLowerCase()], (err: any, row: any) => {
					if (err) {
						console.error('Error checking if request response exists in the database:', err);
						ws.send('Error checking if request response exists in the database');
					}
					if (!row) {
						console.log('Request response does not exist in the database');
						ws.send('Request response does not exist in the database');
					}
					// Delete request response from the database
					db.run('DELETE FROM request_response WHERE key = ?', [key.toLowerCase()]);
					console.log('Request response deleted from the database');
					ws.send('Request response deleted from the database');
				});
			}

			// store code to sqlite3
			if (type === 'code-add') {
				// validate data
				if (!key || !value) {
					ws.send('key or value is missing');
					return;
				}

				// key must start with !!
				if (!key.startsWith('!!')) {
					ws.send('Key must start with !!');
					return;
				}

				db.get('SELECT * FROM code WHERE key = ?', [key.toLowerCase()], (err: any, row: any) => {
					if (err) {
						console.error('Error checking if code exists in the database:', err);
						ws.send('Error checking if code exists in the database');
					}
					if (row) {
						ws.send('Code already exists in the database');
					}
					db.run('INSERT INTO code (key, value) VALUES (?, ?)', [key.toLowerCase(), code]);
					ws.send('Code stored in the database');
				});
			}

			// get codes from sqlite3
			if (type === 'codes') {
				db.all('SELECT * FROM code', (err, rows) => {
					if (err) {
						console.error('Error retrieving code from the database:', err);
						ws.send('Error retrieving code from the database');
					}
					console.log('Code retrieved from the database', rows);
					ws.send(JSON.stringify(rows));
				});
			}
		});

		ws.on('close', () => {
			console.log(`Client disconnected`);
			wssSession = null;
		});
	});

	return server;
}
