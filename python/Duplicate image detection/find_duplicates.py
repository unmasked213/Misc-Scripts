"""
Enhanced Image Duplicate Finder
=================================

This script finds duplicate or similar images in the same folder and creates:
1. An HTML report showing duplicates side by side
2. Organized groups sorted by size and similarity
3. Detailed metadata for each image


To use:
1. Put find_duplicates.py in the folder location you want to scan
2. open cmd in the same folder, then run: python find_duplicates.py


Features:
- Fast mode for large folders (using perceptual hashing)
- Thorough mode for finding modified duplicates (using FFmpeg)
- Detailed EXIF data extraction
- Option to preserve existing results
- Browser-compatible image viewing

Requirements:
- Python 3.6 or higher
- FFmpeg installed (for thorough mode)
- Required Python packages (install with pip):
  pip install Pillow imagehash
"""

import subprocess
import os
import time
import shutil
from pathlib import Path
from datetime import datetime
from PIL import Image
import imghdr
import imagehash
import base64
from io import BytesIO

# Constants
FAST_MODE_THRESHOLD = 5  # Hash difference threshold for fast mode
MAX_THUMBNAIL_SIZE = (800, 800)  # Max size for embedded thumbnails

def get_image_hash(image_path):
    """
    Get perceptual hash of an image using imagehash
    Returns None if the image cannot be processed
    """
    try:
        with Image.open(image_path) as img:
            return str(imagehash.average_hash(img))
    except Exception as e:
        print(f"\nWarning: Could not hash {os.path.basename(image_path)}: {str(e)}")
        return None

def get_image_metadata(image_path):
    """
    Get detailed image information including EXIF data if available
    Returns None if the image cannot be processed
    """
    try:
        with Image.open(image_path) as img:
            metadata = {
                'dimensions': f"{img.width}x{img.height}",
                'format': img.format,
                'mode': img.mode,
                'size_mb': os.path.getsize(image_path) / (1024 * 1024),
                'created': datetime.fromtimestamp(os.path.getctime(image_path)).strftime('%Y-%m-%d %H:%M:%S'),
                'modified': datetime.fromtimestamp(os.path.getmtime(image_path)).strftime('%Y-%m-%d %H:%M:%S'),
                'exif': {}
            }
            
            # Try to get EXIF data
            if hasattr(img, '_getexif') and img._getexif():
                from PIL.ExifTags import TAGS
                exif = img._getexif()
                for tag_id, value in exif.items():
                    tag = TAGS.get(tag_id, tag_id)
                    if isinstance(value, bytes):
                        try:
                            value = value.decode()
                        except:
                            value = str(value)
                    metadata['exif'][tag] = str(value)
                
                # Get key EXIF data if available
                if 'DateTime' in metadata['exif']:
                    metadata['photo_taken'] = metadata['exif']['DateTime']
                if 'Make' in metadata['exif']:
                    metadata['camera_make'] = metadata['exif']['Make']
                if 'Model' in metadata['exif']:
                    metadata['camera_model'] = metadata['exif']['Model']
                if 'Software' in metadata['exif']:
                    metadata['software'] = metadata['exif']['Software']
            
            return metadata
    except Exception as e:
        print(f"\nWarning: Could not read metadata from {os.path.basename(image_path)}: {str(e)}")
        return None

def get_image_signature(image_path):
    """
    Get the signature of an image using FFmpeg
    Returns None and prints warning if the image cannot be processed
    """
    try:
        cmd = [
            'ffmpeg',
            '-i', str(image_path),
            '-vf', 'signature=format=xml:filename=-',
            '-f', 'null', '-'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if 'Error' in result.stderr or 'error' in result.stderr:
            error_msg = result.stderr.split('Error')[1].split('\n')[0] if 'Error' in result.stderr else result.stderr
            print(f"\nWarning: FFmpeg error processing {os.path.basename(image_path)}: {error_msg.strip()}")
            return None
            
        return result.stderr
    except subprocess.CalledProcessError as e:
        print(f"\nWarning: Failed to process {os.path.basename(image_path)}: {str(e)}")
        if e.stderr:
            print(f"FFmpeg error: {e.stderr.decode()}")
        return None
    except Exception as e:
        print(f"\nWarning: Unexpected error processing {os.path.basename(image_path)}: {str(e)}")
        return None

def get_image_thumbnail(image_path):
    """Create base64 encoded thumbnail for HTML embedding"""
    try:
        with Image.open(image_path) as img:
            # Convert to RGB if needed
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            # Create thumbnail
            img.thumbnail(MAX_THUMBNAIL_SIZE)
            # Save to memory
            buffer = BytesIO()
            img.save(buffer, format='JPEG', quality=85)
            # Convert to base64
            return base64.b64encode(buffer.getvalue()).decode()
    except Exception as e:
        print(f"\nWarning: Could not create thumbnail for {os.path.basename(image_path)}: {str(e)}")
        return None

def create_html_report(duplicate_groups, duplicates_dir, fast_mode):
    """Create an HTML report with embedded thumbnails"""
    html_path = duplicates_dir / 'report.html'
    
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Duplicate Images Report</title>
        <style>
            body {{ font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }}
            .group {{ margin-bottom: 40px; border: 1px solid #ccc; padding: 20px; background: white; border-radius: 8px; }}
            .images {{ display: flex; flex-wrap: wrap; gap: 20px; }}
            .image-container {{ flex: 1; min-width: 300px; }}
            .metadata {{ font-size: 14px; margin-top: 10px; }}
            img {{ max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }}
            table {{ border-collapse: collapse; width: 100%; margin-top: 10px; }}
            th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
            th {{ background-color: #f8f8f8; }}
            .modal {{ display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 100; }}
            .modal-content {{ max-width: 90%; max-height: 90%; margin: auto; display: block; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }}
            .mode-info {{ padding: 10px; background: #e8f4f8; border-radius: 4px; margin-bottom: 20px; }}
        </style>
        <script>
            function showImage(src) {{
                const modal = document.createElement('div');
                modal.className = 'modal';
                modal.onclick = () => modal.remove();
                const img = document.createElement('img');
                img.src = src;
                img.className = 'modal-content';
                modal.appendChild(img);
                document.body.appendChild(modal);
            }}
        </script>
    </head>
    <body>
        <h1>Duplicate Images Report</h1>
        <p>Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
        <div class="mode-info">
            Mode: {('Fast (perceptual hash)' if fast_mode else 'Thorough (FFmpeg signature)')}
        </div>
    """
    
    # Sort groups by total size
    sorted_groups = sorted(duplicate_groups, 
                         key=lambda g: sum(os.path.getsize(f) for f in g),
                         reverse=True)
    
    for i, group in enumerate(sorted_groups, 1):
        html_content += f'<div class="group"><h2>Group {i}</h2>'
        html_content += '<div class="images">'
        
        for file in group:
            metadata = get_image_metadata(file)
            thumbnail = get_image_thumbnail(file)
            if metadata and thumbnail:
                img_src = f"data:image/jpeg;base64,{thumbnail}"
                html_content += f"""
                <div class="image-container">
                    <img src="{img_src}" alt="{os.path.basename(file)}" 
                         onclick="showImage('{img_src}')">
                    <div class="metadata">
                        <h3>{os.path.basename(file)}</h3>
                        <table>
                            <tr><th>Property</th><th>Value</th></tr>
                            <tr><td>Dimensions</td><td>{metadata['dimensions']}</td></tr>
                            <tr><td>Format</td><td>{metadata['format']}</td></tr>
                            <tr><td>Size</td><td>{metadata['size_mb']:.2f} MB</td></tr>
                """
                
                # Add EXIF data if available
                if metadata.get('photo_taken'):
                    html_content += f'<tr><td>Taken</td><td>{metadata["photo_taken"]}</td></tr>'
                if metadata.get('camera_make'):
                    html_content += f'<tr><td>Camera</td><td>{metadata["camera_make"]} {metadata.get("camera_model", "")}</td></tr>'
                if metadata.get('software'):
                    html_content += f'<tr><td>Software</td><td>{metadata["software"]}</td></tr>'
                
                html_content += """
                        </table>
                    </div>
                </div>
                """
        
        html_content += '</div></div>'
    
    html_content += '</body></html>'
    
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    
    return html_path
