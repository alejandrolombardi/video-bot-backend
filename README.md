# Video Automation Engine (Backend)

Motor de automatización híbrido diseñado para la generación masiva de contenido audiovisual mediante Inteligencia Artificial. Este sistema orquesta la sincronización de audio, video y subtítulos de manera programada.

## Características Principales

- **Inteligencia Artificial Generativa:**
  - **Google Gemini:** Generación automática de guiones e historias creativas.
  - **Whisk:** Adaptación contextual de prompts para generar imágenes coherentes con cada escena.

- **Procesamiento de Video Avanzado:**
  - **OpenAI Whisper:** Transcripción y generación automática de subtítulos de alta precisión.
  - Soporte multiformato: Renderizado en 9:16 (TikTok/Reels) y 16:9 (YouTube/Horizontal).
  - Mezcla de audio inteligente con música de fondo.

- **Arquitectura del Sistema:**
  - Núcleo híbrido Node.js + Python para optimizar tareas ligeras y pesadas.
  - Uso de FFmpeg para renderizado de alta eficiencia.
  - Automatización web con Puppeteer para recolección de recursos.

## Tecnologías Usadas

- **Core:** Node.js (ES Modules), Python 3.
- **Modelos IA:** Google Gemini, OpenAI Whisper, Whisk.
- **Librerías Clave:** Express, Multer, Puppeteer-core.
- **Herramientas:** FFmpeg, FFprobe.

## Instalación

1. Clonar el repositorio.
2. Instalar dependencias de Node:
   npm install

3. Configurar entorno virtual de Python:
   python -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt

4. Iniciar el motor:
   npm start

---
Desarrollado por Alejandro Lombardi