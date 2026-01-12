import whisper
import sys
import json
import os
import warnings

# Filtramos advertencias molestas de Torch
warnings.filterwarnings("ignore")

def generar_tiempos(audio_path):
    # Verificación de seguridad
    if not os.path.exists(audio_path):
        print(f"[ERROR] El archivo de audio no existe: {audio_path}")
        sys.exit(1)

    # HE QUITADO EL EMOJI DE AQUI PARA QUE WINDOWS NO LLORE
    print(f"[INFO] Cargando modelo Whisper para: {os.path.basename(audio_path)}...")
    
    # Cargar modelo 'base'
    model = whisper.load_model("base")

    # Transcribir con word_timestamps=True
    result = model.transcribe(audio_path, word_timestamps=True)

    base_name = os.path.splitext(audio_path)[0]
    json_path = f"{base_name}.json"

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # AQUI TAMBIEN QUITE EL EMOJI
    print(f"[OK] JSON Guardado: {json_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("[ERROR] Uso: python sincronizar.py <ruta_al_audio>")
        sys.exit(1)
        
    archivo_audio = sys.argv[1]
    generar_tiempos(archivo_audio)