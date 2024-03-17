#!/usr/bin/python3

import sys
import os
import re
import logging
import json
import datetime
import unicodedata
import paramiko
import textfile

class pycolor:
    BLACK = '\033[30m\033[1m'
    RED = '\033[31m\033[1m'
    GREEN = '\033[32m\033[1m'
    YELLOW = '\033[33m\033[1m'
    BLUE = '\033[34m\033[1m'
    PURPLE = '\033[35m\033[1m'
    CYAN = '\033[36m\033[1m'
    WHITE = '\033[37m\033[1m'
    END = '\033[0m'
    BOLD = '\038[1m'
    UNDERLINE = '\033[4m'
    INVISIBLE = '\033[08m'
    REVERCE = '\033[07m'

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

new_tracks = {}
total_num_new_tracks = 0
chart_json_files = []
charts = []
#debug
#os.chdir("/home/koichi/win-home/Downloads/mp3/")
#chart_json_files.append("/home/koichi/win-home/Downloads/mp3/2024-02-22_Moby_Moby You Me Chart.json")

argv = sys.argv
argv.pop(0) # this is the script name
while argv:
    arg = argv.pop(0)
    # if arg == "-u":
    #     print("Is it OK to modify tag (y ot n):",end="")
    #     answer = input()
    #     if answer == 'y':
    #         tag_update = True
    #     else:
    #         logging.error(f"wrong answer {answer}. exiting...")
    #         sys.exit()
    # elif arg == "-v":
    #     verbose = True
    # else:
    if os.path.splitext(arg)[1] == ".json":
        chart_json_files.append(arg)

if len(chart_json_files)==0:
    logging.error("please specify json chart files")
    sys.exit()

for a_json in chart_json_files:
    with open(a_json) as f:
        a_chart = json.load(f)
        a_chart["json_file"] = os.path.basename(a_json)
        charts.append(a_chart)

def concat_trackname(artist, title, version):
    return artist+" - "+title+" - "+version

# build new_tracks[]
for a_chart in charts:
    a_chart['num_of_new_tracks'] = 0
    for i, a_track in enumerate(a_chart["chart"]):
        if not a_track: continue
        if 10 < int(a_track['num']): continue 
        if a_track['mp3_file'] != "": continue # already have 
        a_chart['num_of_new_tracks'] += 1
        artist_track_version = concat_trackname(a_track['artist'], a_track['title'], a_track['version'])
        if artist_track_version in new_tracks:
            new_tracks[artist_track_version] += 1
        else:
            new_tracks[artist_track_version] = 1
            total_num_new_tracks += 1

# https://stackoverflow.com/questions/40419276/python-how-to-print-text-to-console-as-hyperlink
def link(uri, label=None):
    if label is None: 
        label = uri
    parameters = ''
    # OSC 8 ; params ; URI ST <name> OSC 8 ;; ST 
    escape_mask = '\033]8;{};{}\033\\{}\033]8;;\033\\'
    return escape_mask.format(parameters, uri, label)

def chart_name(chart_artist, chart_title):
    if re.match(chart_artist, chart_title):
        return chart_title
    else:
        if re.search(r"s$", chart_artist):
            chart_artist += "'"
        else:
            chart_artist += "'s"
        return chart_artist+" "+chart_title

for a_chart in charts:
    print("")
    print(link(a_chart['chart_url'], chart_name(a_chart['chart_artist'], a_chart['chart_title'])))
    dup_count_text = ""
    for i, a_track in enumerate(a_chart["chart"]):
        if not a_track: continue
        if 10 < int(a_track['num']): continue 
        if a_track['mp3_file'] != "": continue # already have
        if dup_count_text != "": dup_count_text+=","
        artist_track_version = concat_trackname(a_track['artist'], a_track['title'], a_track['version'])
        dup_count_text += str(new_tracks[artist_track_version])
    
    print(pycolor.YELLOW+f"{a_chart['num_of_new_tracks']}({dup_count_text})"+pycolor.END)

print("----------------------------")
print(f"total = {total_num_new_tracks}")