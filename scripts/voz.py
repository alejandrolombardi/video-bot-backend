import asyncio
import edge_tts
import sys

async def generar_voz():
    # sys.argv[1] -> El texto que el bot va a decir
    texto_a_decir = sys.argv[1] if len(sys.argv) > 1 else "No recibí texto de Node"
    
    # sys.argv[2] -> El ID de la voz (es-DO-EmilioNeural, etc.)
    voz = sys.argv[2] if len(sys.argv) > 2 else "es-MX-JorgeNeural"
    
    # sys.argv[3] -> El nombre del archivo único (temp_voz_001.mp3, etc.)
    # Si Node no manda nombre, usamos el de siempre por defecto
    archivo_salida = sys.argv[3] if len(sys.argv) > 3 else "voz_dinamica.mp3"

    try:
        comunicador = edge_tts.Communicate(texto_a_decir, voz)
        await comunicador.save(archivo_salida)
        
        # IMPORTANTE: Imprimimos el nombre real del archivo creado
        print(f"ARCHIVO_CREADO:{archivo_salida}") 
        
    except Exception as e:
        print(f"ERROR_PYTHON:{str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(generar_voz())