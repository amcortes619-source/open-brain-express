# Sesión 2b — Escríbele (o háblale) a tu cerebro (opcional)

**Tiempo: 20 a 30 minutos. Sáltala si andas corto de tiempo — todo lo demás
funciona sin esto.**

Esto te da un bot de Telegram. Le mandas un mensaje desde tu celular y se guarda
en tu cerebro. Le mandas una nota de voz y también la transcribe y la guarda. Le
haces una pregunta y busca. Sin abrir una app, sin navegador, sin escribir una
dirección — nada más un mensaje como cualquier otro.

Es lo que la mayoría termina usando más.

**Si tienes iPhone, esta sesión importa más de lo que suena "opcional."** La
captura de voz en la aplicación instalada no funciona en iPhone — Apple la
bloquea para todo lo que corre desde un ícono en la pantalla de inicio, y la
aplicación misma ya te lo dice si lo intentas. Este bot es el reemplazo real:
háblale aquí en su lugar.

---

## Primero, consigue un bot de Telegram

Necesitas la app de Telegram en tu celular. Si no la tienes:
[telegram.org](https://telegram.org) — regístrate con tu número.

Después:

1. En Telegram busca **@BotFather** — el oficial, tiene palomita azul
2. Mándale: `/start`
3. Mándale: `/newbot`
4. Te pide un nombre — el que quieras, por ejemplo `Mi Cerebro`
5. Te pide un usuario — tiene que terminar en `bot`, por ejemplo `micerebro_bot`
6. Te da un **token** que se ve así: `1234567890:AAF-xxxxxxxxxxxxxxxxx`

**Copia ese token.** Es la contraseña de tu bot — quien lo tenga controla tu
bot. Guárdalo en un lugar seguro por los próximos diez minutos; va a pasar al
almacén de secretos de Supabase y nunca a un archivo.

Después **mándale cualquier mensaje a tu bot nuevo** — un simple hola. Todavía no
va a pasar nada, pero eso crea la conversación, que el siguiente paso necesita.

---

## Después pega esto en Claude Code

> El bloque está en inglés porque son instrucciones técnicas. Claude te va a
> hablar en español.

```
IMPORTANT — LANGUAGE: The person you are working with speaks Spanish. Conduct
this entire session in Spanish. Only commands and code stay in English.

Set up the Telegram bot for this person's Open Brain.

You will need their bot token from BotFather. Ask for it once, store it, and
never repeat it back in the chat.

=== STEP 1 — STORE THE TOKEN ===

  npx supabase secrets set TELEGRAM_BOT_TOKEN=their-token

=== STEP 2 — DEPLOY ===

  npx supabase functions deploy telegram-bot --no-verify-jwt

The --no-verify-jwt flag is required. Telegram cannot send a Supabase login
token, so without it Supabase blocks every message before the code runs and the
bot appears completely dead with nothing useful in the logs.

=== STEP 3 — TELL TELEGRAM WHERE TO SEND MESSAGES ===

Telegram needs to know the address of the function. This is called setting the
webhook and you do it once, by opening a URL.

Build this URL with their real values and have them open it in a browser:

  https://api.telegram.org/bot<THEIR_BOT_TOKEN>/setWebhook?url=https://<THEIR_PROJECT_REF>.supabase.co/functions/v1/telegram-bot

They should see: {"ok":true,"result":true,"description":"Webhook was set"}

If they see "ok":false, read the description — it is usually a typo in the token
or the URL.

=== STEP 4 — LOCK IT TO THEIR PHONE ===

Right now anyone who finds the bot could write into their brain. Fix that.

Have them send their bot any message. The bot will reply with their chat id and
instructions — it is designed to do this before it is locked down.

Take that number and store it:

  npx supabase secrets set TELEGRAM_CHAT_ID=that-number

Then redeploy so it takes effect:

  npx supabase functions deploy telegram-bot --no-verify-jwt

=== STEP 5 — TEST ===

Have them, on their phone:

  1. Send: "Probando mi cerebro desde Telegram"
     Expect a confirmation that it saved.

  2. Wait 15 seconds, then send: /recent
     Expect to see that message listed back.

  3. Send: ? probando
     Expect the same thought found by search.

  4. Send: /count
     Expect a total.

  5. Hold the microphone in Telegram and record a short voice note in
     Spanish — have them say something real.
     Expect a reply within a few seconds echoing back the transcribed text,
     starting with "✅ Guardado desde voz:"

     Explain in Spanish: voice transcription uses the SAME OpenRouter key
     from Session 2, Step 1 — nothing new to add. If the reply instead asks
     for "una llave más" (one more key), OPENROUTER_API_KEY did not make it
     into this project's Supabase secrets; check Session 2 Step 4 was
     actually completed, then redeploy this function.

     If a voice note comes back saying the transcription failed, that is a
     transcription-service hiccup, not a setup problem — have them try
     again. Text capture is unaffected either way. Explain this in Spanish.

If nothing at all comes back, the webhook is the usual culprit. Check it with:

  https://api.telegram.org/bot<THEIR_BOT_TOKEN>/getWebhookInfo

Look at "last_error_message" in the response — it usually says exactly what is
wrong. A 401 there means the function was deployed without --no-verify-jwt.

=== STEP 6 — TELL THEM HOW TO USE IT ===

Explain in Spanish:
  - Manda cualquier cosa -> se guarda
  - Manda una nota de voz -> se transcribe y se guarda, y te responde con el
    texto para que una transcripción mal hecha se note de inmediato
  - ? seguido de una pregunta -> busca por significado
  - /recent -> las últimas 5 cosas
  - /count -> cuánto hay adentro

Point out to an iPhone user specifically, in Spanish: this is now their voice
path. The installed app on their phone cannot do voice capture at all (an
Apple restriction) — the app tells them so and points here.

Suggest they pin the bot to the top of their Telegram list.
```

---

## Lo que ya tienes

Tu cerebro en el bolsillo. Ideas en el coche, en una junta, caminando — las
dices o las escribes al bot y quedan capturadas, etiquetadas y conectadas con
todo lo demás que sabes, antes de que guardes el teléfono.

Todo lo que mandes por aquí aparece en tu aplicación web y Claude lo puede leer,
igual que cualquier otra cosa. Es un solo cerebro con varias puertas.

Si tienes iPhone, esto también arregla un hueco real: la captura de voz en la
aplicación instalada no funciona ahí — Apple la bloquea para todo lo que corre
desde un ícono en la pantalla de inicio. Hablarle a este bot no es un
sustituto para eso — es la forma pensada para capturar por voz en iPhone.

---

## Sigue

De regreso a la **[Sesión 3](Sesion-3-Conectar.md)** — conectar Claude Desktop y
llenar tu cerebro.
