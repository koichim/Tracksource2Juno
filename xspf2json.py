#!/usr/bin/env python3
import xml.etree.ElementTree as ET
import json
import os
import re
import html
import shutil
from datetime import datetime

def split_title_version(full_title):
    """
    Splits a title like 'Title (Version)' into ('Title', 'Version').
    If no parenthesis is found, returns (full_title, "").
    """
    match = re.search(r'^(.*)\((.*)\)\s*$', full_title)
    if match:
        title = match.group(1).strip()
        version = match.group(2).strip()
        return title, version
    return full_title.strip(), ""

def load_external_json(json_path):
    """Loads external chart JSON and returns it as a dict."""
    if not os.path.exists(json_path):
        print(f"Warning: External JSON not found: {json_path}")
        return None
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error reading {json_path}: {e}")
        return None

def convert_xspf(xspf_path):
    if not os.path.exists(xspf_path):
        print(f"Error: File not found: {xspf_path}")
        return

    # Namespace handling
    ns = {'x': 'http://xspf.org/ns/0/'}
    
    try:
        tree = ET.parse(xspf_path)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"Error parsing XML: {e}")
        return

    now = datetime.now()
    year_now = now.strftime("%Y")
    date_str = now.strftime("%Y-%m-%d")

    output_filename = f"{year_now} favorites.json"
    source_path = f"/mnt/h/music/{year_now}/tracks/{output_filename}"

    # If the file exists on the H: drive but not locally, copy it over
    if os.path.exists(source_path) and not os.path.exists(output_filename):
        print(f"Copying {source_path} to current directory...")
        shutil.copy2(source_path, output_filename)

    # Load existing JSON if it already exists (append mode)
    if os.path.exists(output_filename):
        with open(output_filename, 'r', encoding='utf-8') as f:
            data = json.load(f)
        print(f"Appending to existing {output_filename} ({len(data['chart'])} tracks already present)")
    else:
        data = {
            "date": date_str,
            "chart_artist": "Koichi Masuda",
            "chart_title": f"{year_now} favorites",
            "chart_url": "",
            "chart": []
        }

    # Build set of already-known mp3 basenames to prevent duplicates
    existing_basenames = {os.path.basename(e.get("mp3_file", "")) for e in data["chart"] if e}

    # External JSON cache to avoid reloading same file
    json_cache = {}
    new_tracks = []  # Tracks to be added this run (not yet in existing chart)
    seen_basenames = set(existing_basenames)  # Track all seen basenames (existing + new) in real time
    dup_count = 0  # Count of duplicates removed

    tracklist = root.find('x:trackList', ns)
    if tracklist is not None:
        for track in tracklist.findall('x:track', ns):
            location_el = track.find('x:location', ns)
            full_title_el = track.find('x:title', ns)
            artist_el = track.find('x:creator', ns)

            raw_location = html.unescape(location_el.text) if location_el is not None else ""
            if not raw_location:
                continue

            full_title = html.unescape(full_title_el.text) if full_title_el is not None else ""
            artist = html.unescape(artist_el.text) if artist_el is not None else ""

            if raw_location.startswith('#'):
                # Case 1: External JSON Lookup
                clean_location = raw_location[1:] # Remove #
                parts = clean_location.split('/')
                if len(parts) >= 2:
                    dir_name = parts[0]
                    base_filename = parts[-1]
                    year_prefix = dir_name[:4]
                    
                    external_json_path = f"/mnt/h/music/{year_prefix}/tracks/{dir_name}.json"
                    
                    metadata = json_cache.get(external_json_path)
                    if metadata is None:
                        metadata = load_external_json(external_json_path)
                        json_cache[external_json_path] = metadata
                    
                    found = False
                    if metadata and "chart" in metadata:
                        # Try exact match first
                        for entry in metadata["chart"]:
                            if not entry: continue
                            target_mp3 = entry.get("mp3_file", "")
                            if os.path.basename(target_mp3) == base_filename:
                                if target_mp3 == "":
                                    print(f"Skipping track (empty mp3_file): {base_filename}")
                                    found = True
                                    track_entry = None
                                    break
                                track_entry = {k: v for k, v in entry.items() if k != "num"}
                                found = True
                                break
                        
                        # Try matching with track numbers stripped if not found
                        if not found:
                            def strip_prefix(s):
                                return re.sub(r'^\d+(\s*-\s*\d+)*\s*-\s*', '', s)
                            
                            clean_base = strip_prefix(base_filename)
                            for entry in metadata["chart"]:
                                if not entry: continue
                                target_mp3 = entry.get("mp3_file", "")
                                if strip_prefix(os.path.basename(target_mp3)) == clean_base:
                                    if target_mp3 == "":
                                        print(f"Skipping track (empty mp3_file, fuzzy match): {base_filename}")
                                        found = True
                                        track_entry = None
                                        break
                                    track_entry = {k: v for k, v in entry.items() if k != "num"}
                                    found = True
                                    break
                    
                    if not found:
                        print(f"Skipping track (not in {os.path.basename(external_json_path)}): {base_filename}")
                        continue
                else:
                    print(f"Warning: Invalid location format: {raw_location}")
            else:
                # Case 2: Direct path validation
                year_prefix = raw_location[:4]
                full_physical_path = f"/mnt/h/music/{year_prefix}/{raw_location}"
                
                if os.path.exists(full_physical_path):
                    mp3_path = f"/music/{year_prefix}/{raw_location}"
                else:
                    print(f"Error: Physical file not found: {full_physical_path}")
                    mp3_path = raw_location # Fallback or keep as is

                title, version = split_title_version(full_title)
                track_entry = {
                    "title": title,
                    "version": version,
                    "artist": artist,
                    "mp3_file": mp3_path
                }

            if track_entry:
                bname = os.path.basename(track_entry.get("mp3_file", ""))
                if bname in seen_basenames:
                    print(f"Dedup: removing duplicate '{bname}'")
                    dup_count += 1
                else:
                    seen_basenames.add(bname)
                    new_tracks.append(track_entry)

    # Rebuild: existing entries + unique new entries
    data["chart"] = new_tracks + [e for e in data["chart"] if e and os.path.basename(e.get("mp3_file", "")) in existing_basenames]

    with open(output_filename, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Successfully wrote {output_filename}")
    print(f"Total tracks: {len(data['chart'])} (added: {len(new_tracks)}, duplicates removed: {dup_count})")

if __name__ == "__main__":
    import sys
    input_file = "お気に入り.xspf"
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
    
    convert_xspf(input_file)
