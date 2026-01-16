require('dotenv').config()
const express = require('express')
const axios = require('axios')
const cheerio = require('cheerio')
const cron = require('node-cron')
const twilio = require('twilio')
const dayjs = require('dayjs')

// Configuración de Dayjs para zona horaria y plugins
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
const isBetween = require('dayjs/plugin/isBetween')
const customParseFormat = require('dayjs/plugin/customParseFormat')

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(isBetween)
dayjs.extend(customParseFormat)

const app = express()
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

// --- Lógica de Scraping ---
const puppeteer = require('puppeteer')

async function obtenerCauciones() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Ayuda con la memoria compartida en contenedores
    ],
  })
  try {
    const page = await browser.newPage()
    await page.goto('https://www.dolarito.ar/merval/cauciones', {
      waitUntil: 'networkidle0',
      timeout: 30000,
    })

    // Esperar a que la tabla esté renderizada (ajustar selector según el DOM real)
    await page.waitForSelector('table', { timeout: 15000 })

    const cauciones = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'))
      const result = []

      for (const row of rows) {
        const cols = row.querySelectorAll('td')
        if (cols.length < 2) continue

        const colPlazo = cols[0].innerText.trim()
        const colTasa = cols[1].innerText.trim()

        const matchPlazo = colPlazo.match(/(\d+)/)
        const plazo_dias = matchPlazo ? parseInt(matchPlazo[1], 10) : NaN

        const matchTasa = colTasa
          .replace(/\s/g, '')
          .replace(',', '.')
          .match(/([\d.]+)/)
        const tasa_actual = matchTasa ? parseFloat(matchTasa[1]) : NaN

        if (!Number.isNaN(plazo_dias) && !Number.isNaN(tasa_actual)) {
          result.push({ plazo_dias, tasa_actual })
        }
      }

      return result.sort((a, b) => b.tasa_actual - a.tasa_actual)
    })

    return cauciones
  } finally {
    await browser.close()
  }
}

// --- Lógica de Negocio y Notificación ---
async function procesarCauciones() {
  const todas = await obtenerCauciones()
  const minTNA = parseFloat(process.env.MIN_TNA || 0)

  // Filtrar las que superan la TNA definida
  const oportunidades = todas.filter((c) => c.tasa_actual > minTNA)

  return {
    todas,
    oportunidades,
  }
}

async function notificarSiCorresponde(oportunidades) {
  if (oportunidades.length === 0) return

  // Construir mensaje
  let body = `🚀 *Oportunidades de Caución (> ${process.env.MIN_TNA}%)* 🚀\n\n`
  oportunidades.slice(0, 10).forEach((op) => {
    // Top 10 para no saturar
    body += `📅 Plazo: ${op.plazo_dias} días - 📈 Tasa: ${op.tasa_actual}%\n`
  })

  try {
    const message = await client.messages.create({
      body: body,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.TWILIO_WHATSAPP_TO,
    })
    console.log(
      `WhatsApp enviado a la red. SID: ${message.sid} - Estado: ${message.status}`
    )
  } catch (error) {
    // Códigos de error típicos cuando el usuario no está unido al Sandbox
    if (error.code === 63015 || error.code === 21610) {
      console.error(
        '⚠️  ALERTA DE SANDBOX: La sesión de WhatsApp caducó o no existe.'
      )
      console.error(
        `👉 Por favor, envía "join <tu-palabra-clave>" al número ${process.env.TWILIO_WHATSAPP_FROM} para volver a recibir alertas.`
      )
    } else {
      console.error('Error enviando WhatsApp:', error.message)
    }
  }
}

// --- Verificación de Horario de Mercado ---
function esHorarioDeMercado() {
  const ahora = dayjs().tz('America/Argentina/Buenos_Aires')
  const diaSemana = ahora.day() // 0 = Domingo, 1 = Lunes, ... 6 = Sábado

  // Verificar Lunes (1) a Viernes (5)
  if (diaSemana < 1 || diaSemana > 5) return false

  // Crear objetos de hora para comparar
  const inicio = ahora.clone().hour(10).minute(30).second(0)
  const fin = ahora.clone().hour(21).minute(30).second(0)

  return ahora.isBetween(inicio, fin, null, '[]') // [] incluye los límites
}

// --- Endpoint HTTP ---
app.get('/api/cauciones', async (req, res) => {
  try {
    const { todas, oportunidades } = await procesarCauciones()

    // Si se llama manualmente al endpoint, también verificamos si hay que notificar
    // (Opcional: quitar si solo quieres notificar con el cron)
    if (req.query.notificar === 'true' && esHorarioDeMercado()) {
      await notificarSiCorresponde(oportunidades)
    }

    res.json({
      timestamp: dayjs().format(),
      mercado_abierto: esHorarioDeMercado(),
      min_tna_config: process.env.MIN_TNA,
      cantidad_encontrada: todas.length,
      oportunidades_detectadas: oportunidades.length,
      data: todas,
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// --- Tarea Programada (Cron) ---
// Se ejecuta según la variable CRON_SCHEDULE (ej: "*/15 * * * *" para cada 15 min)
if (process.env.CRON_SCHEDULE) {
  cron.schedule(process.env.CRON_SCHEDULE, async () => {
    console.log('Ejecutando tarea programada...')

    if (!esHorarioDeMercado()) {
      console.log('Fuera de horario de mercado. No se escanea.')
      return
    }

    const { todas, oportunidades } = await procesarCauciones()

    console.log(
      `Escaneo finalizado. Total encontradas: ${todas.length}. Oportunidades (> ${process.env.MIN_TNA}%): ${oportunidades.length}`
    )

    if (oportunidades.length > 0) {
      console.log(
        `Encontradas ${oportunidades.length} oportunidades. Notificando...`
      )
      await notificarSiCorresponde(oportunidades)
    }
  })
}

// --- Tarea de Mantenimiento (Recordatorio de Sesión) ---
// Se ejecuta cada 2 días a las 09:00 AM para evitar que caduque el Sandbox (72hs)
cron.schedule('0 9 */2 * *', async () => {
  try {
    await client.messages.create({
      body: '🤖 *Mantenimiento Bot*\n\nPara evitar que la sesión de prueba caduque, por favor responde a este mensaje con cualquier texto (ej: "ok").',
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.TWILIO_WHATSAPP_TO,
    })
    console.log('Recordatorio de mantenimiento enviado.')
  } catch (error) {
    console.error(
      'Error enviando recordatorio de mantenimiento:',
      error.message
    )
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`))
