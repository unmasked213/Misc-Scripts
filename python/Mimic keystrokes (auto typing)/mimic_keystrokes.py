import keyboard
import pyautogui
import time
import random
from pathlib import Path
import win32gui
import logging
import sys

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')

class TextInputSimulator:
    def __init__(self):
        self.paused = False
        self.running = True
        self.current_window = None
        pyautogui.PAUSE = 0

    def check_window_focus(self):
        return self.current_window == win32gui.GetForegroundWindow()

    def toggle_pause(self):
        self.paused = not self.paused
        logging.info('Typing %s', 'paused' if self.paused else 'resumed')

    def stop(self):
        self.running = False
        logging.info('Stopping typing simulation')

    def type_text_realistically(self, text):
        """Simulates realistic human typing with random delays between keystrokes."""
        self.current_window = win32gui.GetForegroundWindow()
        for char in text:
            if not self.running:
                break
            pyautogui.write(char)  # Type the character
            time.sleep(random.uniform(0.05, 0.2))  # Random delay between keystrokes

def read_file_safely(file_path):
    """Attempts to read the file using different encodings."""
    encodings = ['utf-8', 'utf-8-sig', 'iso-8859-1', 'cp1252']
    
    for encoding in encodings:
        try:
            with open(file_path, 'r', encoding=encoding) as file:
                return file.read()
        except UnicodeDecodeError:
            logging.warning(f"Encoding {encoding} failed. Trying next...")
        except Exception as e:
            logging.error(f"Error reading file with {encoding}: {str(e)}")
    
    # Final fallback: read as binary and decode manually
    try:
        with open(file_path, 'rb') as file:
            raw_data = file.read()
            return raw_data.decode('utf-8', errors='replace')  # Replace invalid characters
    except Exception as e:
        raise ValueError("Unable to read the file with any supported encoding") from e

def main():
    print("Auto-Typing Script Started")
    print("1. Please ensure your text file 'content_to_imitate.txt' is in the same folder as this script")
    print("2. Click where you want to type")
    print("3. The typing will begin in 5 seconds")
    print("4. Press 'ESC' to stop at any time")
    print("\nChecking for text file...")
    
    script_dir = Path(__file__).parent
    input_file = script_dir / "content_to_imitate.txt"
    
    pyautogui.FAILSAFE = True
    
    try:
        if not input_file.exists():
            print(f"\nERROR: Could not find 'content_to_imitate.txt' in {script_dir}")
            input("Press Enter to exit...")
            return

        text = read_file_safely(input_file)
        if not text.strip():
            print("\nError: File is empty or contains only whitespace")
            input("Press Enter to exit...")
            return

        print("\nFile loaded successfully!")
        simulator = TextInputSimulator()
        
        keyboard.on_press_key('esc', lambda _: simulator.stop())
        
        print("\nStarting countdown...")
        for i in range(5, 0, -1):
            print(f"Starting in {i}...")
            time.sleep(1)
        print("Typing now!")
        
        simulator.type_text_realistically(text)
        print("\nTyping completed!")
        
    except Exception as e:
        print(f"\nError occurred: {str(e)}")
    
    input("\nPress Enter to exit...")

if __name__ == "__main__":
    main()
