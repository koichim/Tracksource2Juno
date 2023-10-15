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

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

#This script is assumed to run in Downloads/mp3 or music/20xx/
new_mp3_tracks_dir = os.path.join("tracks", "mp3")
#chart_json_files = ["2023-09-27_The Shapeshifters_WTF CHART.json", "2023-09-28_Louie Vega_Louie Vega’s_.json","2023-10-03_Seamus Haji_Malta Moments.json","2023-10-05_David Penn_David Penn Fever chart.json"]
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
    logging.error("please specify json chart files")
    sys.exit()

mp3_tracks_dirs = []
this_year = datetime.datetime.now().year
mp3_tracks_dirs.append(new_mp3_tracks_dir) # just purchased
this_year_tracks_dir = os.path.join("/mnt", "h", "music", str(this_year), "tracks", "mp3")
if os.path.abspath(new_mp3_tracks_dir) != this_year_tracks_dir:
    mp3_tracks_dirs.append(this_year_tracks_dir) # this year
mp3_tracks_dirs.append(os.path.join("/mnt", "h", "music", str(this_year-1), "tracks", "mp3")) # last year

mp3_files = []
new_mp3_files = []
for an_mp3_dir in mp3_tracks_dirs:
    if not os.path.isdir(an_mp3_dir):
        print(f"{an_mp3_dir} is not DIR name. Skip.")
        continue
    logging.debug(f"DIR: {an_mp3_dir} ")
    files = os.listdir(an_mp3_dir)
    for a_file in files:
        if os.path.splitext(a_file)[1] == ".mp3":
            # check dup since already copied to music/20xx/tracks
            dup = False
            for a_file_already_in in mp3_files:
                if os.path.basename(a_file_already_in) == a_file:
                    dup = True
                    break
            if not dup:
                mp3_files.append(os.path.join(an_mp3_dir, a_file))
        if an_mp3_dir == new_mp3_tracks_dir:
            new_mp3_files.append(a_file)

def normalize_unicode(words: str) -> str:
    unicode_words = ""
    for character in unicodedata.normalize("NFD", words):
        if unicodedata.category(character) != "Mn":
            unicode_words += character
    return unicode_words

old_json_files = {}
for a_json in chart_json_files:
    with open(a_json) as f:
        a_chart = json.load(f)
        a_chart["json_file"] = os.path.basename(a_json)
        charts.append(a_chart)
        old_json_files[a_chart["json_file"]] = a_json
        

def artist_title_cleansing(str):
    str = normalize_unicode(str)
    str = re.sub(r"'", "", str) #I'm -> im, Mousse T's -> Mousse Ts
    str = re.sub(r"[^a-zA-Z0-9]", " ", str)
    str = str.lower()
    strs = str.split()
    for i, a_str in enumerate(strs[:]):
        if a_str == "extended" or \
            a_str == "remix" or \
            a_str == "mix" or \
            a_str == "feat" or \
            a_str == "original" or \
            a_str == "presents" or \
            a_str == "pres":
            strs.remove(a_str)
    return strs

def comp_arrays_rm_match(array_i, array_j):
    for i, an_entry_i in enumerate(array_i[:]):
        for j, an_entry_j in enumerate(array_j[:]):
            if an_entry_i == an_entry_j:
                array_i.remove(an_entry_i)
                array_j.remove(an_entry_j)
                return True
    return False

def look_for_mp3(artist, title, version=""):
    artist_title = f"{artist} {title} {version}"
    artist_title_words = artist_title_cleansing(artist_title) 
    score = 0 # smallest is the best
    hit_ratio = 0.0
    the_best_mp3_file = ""
    for an_mp3_file in mp3_files:
        tmp_artist_title_words = artist_title_words.copy()
        filename = os.path.basename(an_mp3_file)
        filename = re.sub(r"\.mp3", "", filename)
        filename_words = artist_title_cleansing(filename)
        total_len = len(filename_words) + len(tmp_artist_title_words)
        hit = 0
        while comp_arrays_rm_match(filename_words, tmp_artist_title_words):
            hit += 1
        if hit_ratio < (hit*2 / total_len):
            score = hit
            the_best_mp3_file = an_mp3_file
            hit_ratio = hit*2 / total_len
            
    return the_best_mp3_file, score, hit_ratio
    
referred_mp3_files = []
for a_chart in charts:
    print("")
    print(f"{a_chart['chart_title']} by {a_chart['chart_artist']} on {a_chart['date']}")
    for i, a_track in enumerate(a_chart["chart"]):
        the_mp3_file, score, hit_ratio = look_for_mp3(a_track['artist'], a_track['title'], version=a_track['version'])
        the_mp3_file_wo_ver, score_wo_ver, hit_ratio_wo_ver = look_for_mp3(a_track['artist'], a_track['title'])
        if hit_ratio < hit_ratio_wo_ver:
            the_mp3_file = the_mp3_file_wo_ver
            score = score_wo_ver
            hit_ratio = hit_ratio_wo_ver
        if a_track['version']:
            logging.info(f"{a_track['num']:>2}------- {a_track['artist']} / {a_track['title']} ({a_track['version']})")
        else:
            logging.info(f"{a_track['num']:>2}------- {a_track['artist']} / {a_track['title']}")
        logging.info(f"({score} / {hit_ratio:3.2}){os.path.basename(the_mp3_file)}")
        
        if 0.8 < hit_ratio:
            if re.search(str(this_year), os.path.dirname(the_mp3_file)):
                # because new_dir ones incl. json will be moved to this_year dir. 
                # so, new and this year mp3 can be point to rerative path.
                the_mp3_file = os.path.join(new_mp3_tracks_dir, os.path.basename(the_mp3_file))
            a_track["mp3_file"] = the_mp3_file
            referred_mp3_files.append(os.path.basename(the_mp3_file))

        elif int(a_track["num"]) <= 10:
            logging.warning(f"{a_track['num']:>2}------- {a_track['artist']} / {a_track['title']} ({a_track['version']})")
            logging.warning(f"({score} / {hit_ratio:3.2}){os.path.basename(the_mp3_file)}")
    
    an_updated_chart_json_file = os.path.join("tracks", a_chart["json_file"])
    if os.path.exists(an_updated_chart_json_file):
        print(f"{an_updated_chart_json_file} exists. skip.")
    else:
        with open(an_updated_chart_json_file, 'w') as f:
            json.dump(a_chart, f, ensure_ascii=False, indent=4, sort_keys=False, separators=(',', ': '))
    # if not os.path.abspath(an_updated_chart_json_file) == os.path.abspath(old_json_files[a_chart["json_file"]]):
    #     os.remove(old_json_files[a_chart["json_file"]])


print("******* sftp.put my_mp3_tracks.json to SPPD *******")
my_mp3_tracks = {"date": f"{datetime.datetime.now().year}-{datetime.datetime.now().month}-{datetime.datetime.now().day}",
                 "mp3_tracks":[]}
for an_mp3_file in mp3_files:
    my_mp3_tracks["mp3_tracks"].append({"file":os.path.basename(an_mp3_file)})
tmp_my_mp3_js_file = os.path.join("/tmp", "my_mp3_tracks.json")
with open(tmp_my_mp3_js_file, 'w') as f:
    json.dump(my_mp3_tracks, f, ensure_ascii=False, indent=4, sort_keys=False, separators=(',', ': '))
#textfile.insert(tmp_my_mp3_js_file, 'const my_mp3_tracks = \n', line=0)
#textfile.append(tmp_my_mp3_js_file, ';\n')

sppd_host="masuda.sppd.ne.jp"
sppd_username=os.environ.get("SPPD_USERNAME")
sppd_password=os.environ.get("SPPD_PASSWD")
if not sppd_username or not sppd_password:
    logging.error("no sppd username/passwd info")
else:
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=sppd_host, username=sppd_username, password=sppd_password, timeout=10, look_for_keys=False)
    
    try:
        # SFTPセッション開始
        sftp_connection = client.open_sftp()
    
        # ローカルPCからリモートサーバーへファイルを転送
        sftp_connection.put(tmp_my_mp3_js_file, "www/etc/my_mp3_tracks.json")
    finally:
        client.close()
        print("done")
        

# look for new mp3 files not included in json
print("******* unreferred new mp3 file check *******")
referred_mp3_files_set = set(referred_mp3_files) # remoev dup
for i, a_new_mp3_file in enumerate(new_mp3_files[:]):
    for a_referred_mp3_file in referred_mp3_files_set:
        if a_new_mp3_file == a_referred_mp3_file:
            new_mp3_files.remove(a_new_mp3_file)

if len(new_mp3_files) == 0:
    print("none!")
else:
    for an_unreferred_mp3_file in new_mp3_files:
        print(an_unreferred_mp3_file)

