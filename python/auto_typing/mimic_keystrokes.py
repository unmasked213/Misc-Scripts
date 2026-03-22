import keyboard
import pyautogui
import time
import random
from pathlib import Path
import win32gui
import logging

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
        """Simulate realistic typing with random delays."""
        self.current_window = win32gui.GetForegroundWindow()
        for char in text:
            if not self.running:
                break
            pyautogui.write(char)  # Type the character
            # Random delay between keystrokes
            time.sleep(random.uniform(0.05, 0.2))


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
            # Replace invalid characters
            return raw_data.decode('utf-8', errors='replace')
    except Exception as e:
        msg = "Unable to read the file with any supported encoding"
        raise ValueError(msg) from e


def main():
    print("Auto-Typing Script Started")
    msg = "1. Please ensure 'content_to_imitate.txt' is in same folder"
    print(msg)
    print("2. Click where you want to type")
    print("3. The typing will begin in 5 seconds")
    print("4. Press 'ESC' to stop at any time")
    print("\nChecking for text file...")

    script_dir = Path(__file__).parent
    input_file = script_dir / "content_to_imitate.txt"

    pyautogui.FAILSAFE = True

    try:
        if not input_file.exists():
            msg = f"\nERROR: Could not find file in {script_dir}"
            print(msg)
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
