require('dotenv').config()
const express = require('express')
const dayjs = require('dayjs')

const { procesarCauciones, notificarSiCorresponde, esHorarioDeMercado } = require('./bot')

const app = express()

app.get('/api/cauciones', async (req, res) => {
  try {
    const { todas, oportunidades } = await procesarCauciones()

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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`))
