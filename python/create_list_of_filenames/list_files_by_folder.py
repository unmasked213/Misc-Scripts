# filename: list_files_by_folder.py
# Python 3.9+

from pathlib import Path


def format_size(size: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024:
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} PB"


def main():
    try:
        root = Path(__file__).parent
        output_file = root / "file_list.txt"

        print(f"Scanning: {root}")

        folder_data = []
        total_files = 0
        total_size = 0

        for folder_path in sorted(root.rglob("*")):
            if not folder_path.is_dir():
                continue

            files = [
                f for f in sorted(folder_path.iterdir())
                if f.is_file()
                and not f.name.startswith(".")
                and f.name != "list_files_by_folder.py"
            ]

            if not files:
                continue

            rel = folder_path.relative_to(root)
            depth = len(rel.parts) if rel != Path(".") else 0
            indent = "\t" * depth
            header = "Root" if rel == Path(".") else str(rel)

            folder_size = 0
            file_list = []
            for f in files:
                try:
                    sz = f.stat().st_size
                except (OSError, PermissionError):
                    sz = 0
                folder_size += sz
                total_size += sz
                total_files += 1
                file_list.append(f"{indent}{f.name}")

            folder_data.append(
                (header, indent, len(file_list), folder_size, file_list)
            )

        print(f"Found {total_files} files in {len(folder_data)} folders")

        with output_file.open("w", encoding="utf-8-sig") as out:
            out.write("=== Summary ===\n")
            if folder_data:
                for header, _, count, size, _ in folder_data:
                    line = (f"[{header}] - "
                            f"{count} files, {format_size(size)}\n")
                    out.write(line)
            else:
                out.write("(No files found)\n")
            total_line = (f"\nTotal: {total_files} files, "
                          f"{format_size(total_size)}\n\n")
            out.write(total_line)

            for header, indent, _, _, files in folder_data:
                out.write(f"{indent}[{header}]\n")
                for f in files:
                    out.write(f + "\n")
                out.write("\n\n")

        print(f"Written: {output_file.name}")

    except Exception as e:
        print(f"ERROR: {e}")

    input("Press Enter to exit...")


if __name__ == "__main__":
    main()
