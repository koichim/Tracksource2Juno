#!/usr/bin/python3

import shutil
import sys
import os
import re
import logging
import json
import datetime
from mutagen.id3 import ID3,TRCK,TALB

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

#This script is assumed to run in Downloads/mp3 or music/20xx/
new_mp3_tracks_dir = os.path.join("tracks", "mp3")
#chart_json_files = ["2023-10-09_Colette_Colette Love Will Set You Free  Top Ten.json"]
chart_json_files = []
charts = []

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
    logging.error("please specify json chart files which include mp3 file info")
    sys.exit()

this_year = datetime.datetime.now().year
this_year_tracks_dir = os.path.join("/mnt", "h", "music", str(this_year))
last_year_tracks_dir = (os.path.join("/mnt", "h", "music", str(this_year-1))) # last year

for a_json in chart_json_files:
    with open(a_json) as f:
        a_chart = json.load(f)
        if a_chart.get("json_file"): #if not, the json was just downloaded
            charts.append(a_chart)

for a_chart in charts:
    chart_mp3_dir = "#"+re.sub(r".json$", "", a_chart["json_file"])
    print(f"making {a_chart['json_file']} folder")
    os.mkdir(chart_mp3_dir)
    for an_mp3 in a_chart["chart"]:
        if not an_mp3: continue
        an_mp3_file = an_mp3.get("mp3_file")
        if an_mp3_file:
            exsisting_mp3_file = ""
            if os.path.exists(an_mp3_file):
                exsisting_mp3_file = an_mp3_file
            elif os.path.exists(os.path.join(this_year_tracks_dir, an_mp3_file)):
                exsisting_mp3_file = os.path.join(this_year_tracks_dir, an_mp3_file)
            elif os.path.exists(os.path.join(last_year_tracks_dir, an_mp3_file)):
                exsisting_mp3_file = os.path.join(last_year_tracks_dir, an_mp3_file)
            
            if not exsisting_mp3_file:
                num = an_mp3.get("num")
                logging.error(f"{num} - {an_mp3_file} does not exist...")
            elif not os.path.splitext(exsisting_mp3_file)[1] == ".mp3":
                logging.error(f"{exsisting_mp3_file} is not mp3...")
            else:
                the_copied_mp3_file = os.path.join(chart_mp3_dir, f"{an_mp3['num']:0>2} - {os.path.basename(exsisting_mp3_file)}")
                shutil.copy(exsisting_mp3_file, the_copied_mp3_file)
                
                # update track number and album name of the copied mp3
                tags = ID3(the_copied_mp3_file)
                tags['TRCK'] = TRCK(encoding=3, text=u''+an_mp3['num']+'')
                if re.match(a_chart['chart_artist'], a_chart['chart_title'], re.IGNORECASE):
                    tags['TALB'] = TALB(encoding=3, text=u"#"+an_mp3['num']+" "+a_chart['chart_title']+" ("+a_chart["date"]+")")
                else:
                    the_chart_artist = a_chart['chart_artist']
                    if re.search(r"s$", the_chart_artist):
                        the_chart_artist += "'"
                    else:
                        the_chart_artist += "'s"
                    tags['TALB'] = TALB(encoding=3, text=u"#"+an_mp3['num']+" "+the_chart_artist+" "+a_chart['chart_title']+" ("+a_chart["date"]+")")
                tags.save()


