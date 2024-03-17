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


#This script is assumed to run in Downloads/mp3 or music/20xx/
new_mp3_tracks_dir = os.path.join("tracks", "mp3")
#chart_json_files = ["2023-10-06_Milk Sugar_Milk Sugar House Nation playlist.json"]
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

mp3_tracks_dirs = []
if os.path.isdir(new_mp3_tracks_dir): mp3_tracks_dirs.append(new_mp3_tracks_dir) # just purchased
this_year = datetime.datetime.now().year
my_mp3_this_year_dir = os.path.join("/mnt", "h", "music", str(this_year))
this_year_tracks_dir = os.path.join(my_mp3_this_year_dir, "tracks", "mp3")
if os.path.isdir(this_year_tracks_dir) and os.path.abspath(new_mp3_tracks_dir) != this_year_tracks_dir:
    mp3_tracks_dirs.append(this_year_tracks_dir) # this year
my_mp3_last_year_dir = os.path.join("/mnt", "h", "music", str(this_year-1))
mp3_tracks_dirs.append(os.path.join(my_mp3_last_year_dir, "tracks", "mp3")) # last year

# search mp3 in albums also
my_mp3_purchased_albums_dirs = []
if os.path.abspath(".") != os.path.abspath(my_mp3_this_year_dir):
    # probably in Downlaod/mp3
    my_mp3_purchased_albums_dirs = os.listdir(".")
    my_mp3_purchased_albums_dirs = list(map(lambda x: os.path.join(os.path.abspath("."), x), my_mp3_purchased_albums_dirs))
if os.path.isdir(my_mp3_this_year_dir):
    my_mp3_this_year_albums_dirs = os.listdir(my_mp3_this_year_dir)
    my_mp3_this_year_albums_dirs = list(map(lambda x: os.path.join(my_mp3_this_year_dir, x), my_mp3_this_year_albums_dirs))
else: my_mp3_this_year_albums_dirs = []
my_mp3_last_year_albums_dirs = os.listdir(my_mp3_last_year_dir) # must exist
my_mp3_last_year_albums_dirs = list(map(lambda x: os.path.join(my_mp3_last_year_dir, x), my_mp3_last_year_albums_dirs))
my_mp3_albums_dirs = my_mp3_purchased_albums_dirs + my_mp3_this_year_albums_dirs + my_mp3_last_year_albums_dirs
my_mp3_albums_dirs = list(set(my_mp3_albums_dirs)) # there would be two "tracks"
my_mp3_albums_dirs = sorted(my_mp3_albums_dirs, reverse=True, key=lambda x: os.path.basename(x))
for i,an_mp3_album_dir in  enumerate(my_mp3_albums_dirs[:]):
    if not os.path.isdir(an_mp3_album_dir) or \
        os.path.basename(an_mp3_album_dir) == "tracks":# or \
        # not re.search(r"^20\d\d-", os.path.basename(an_mp3_album_dir)):
        my_mp3_albums_dirs.remove(an_mp3_album_dir)
my_mp3_albums_dirs = my_mp3_albums_dirs[:50] # pick recent 50
my_mp3_albums_dirs = list(map(lambda x: os.path.join(x, "mp3"), my_mp3_albums_dirs))
mp3_tracks_dirs += my_mp3_albums_dirs



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
    #for character in unicodedata.normalize("NFC", words):
    #for character in unicodedata.normalize("NFKC", words):
    #for character in unicodedata.normalize("NFKD", words):
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
        

def artist_title_cleansing(str, rm_dup=True):
    str = normalize_unicode(str)
    str = re.sub(r"ø", "o", str) # can not normalize_unicode
    str = re.sub(r"['’´]", "", str) #I'm -> im, Mousse T's -> Mousse Ts
    str = re.sub(r"[^a-zA-Z0-9]", " ", str)
    str = str.lower()
    strs = str.split()
    if rm_dup: strs = list(set(strs)) # remove duplication
    for i, a_str in enumerate(strs[:]):
        if a_str == "presents" or \
            a_str == "pres" or \
            a_str == "remix" or \
            a_str == "mix" or \
            a_str == "feat":
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

def get_album_dir_name(an_mp3_file):
    return os.path.basename(os.path.dirname(os.path.abspath(os.path.join(an_mp3_file, os.path.pardir))))

class Look4mp3_result(object):
    def __init__(self, mp3_file, score, hit_ratio):
        self.mp3_file = mp3_file
        self.score = score
        self.hit_ratio = hit_ratio
    def __repr__(self):
        return self.mp3_file
def look_for_mp3(artist, title, version="", rm_dup=True):
    artist_title = f"{artist} {title} {version}"
    artist_title_words = artist_title_cleansing(artist_title, rm_dup) 
    score = 0 # smallest is the best
    hit_ratio = 0.0
    the_best_mp3_file = ""
    for an_mp3_file in mp3_files:
        tmp_artist_title_words = artist_title_words.copy()
        filename = os.path.basename(an_mp3_file)
        if get_album_dir_name(an_mp3_file) != "tracks":
            filename = re.sub(r"^\d+ - (.+ - .+\.mp3)$", r"\1", filename)
        filename = re.sub(r"\.mp3", "", filename)
        filename_words = artist_title_cleansing(filename, rm_dup)
        total_len = len(filename_words) + len(tmp_artist_title_words)
        hit = 0
        while comp_arrays_rm_match(filename_words, tmp_artist_title_words):
            hit += 1
        if hit_ratio < (hit*2 / total_len):
            score = hit
            the_best_mp3_file = an_mp3_file
            hit_ratio = hit*2 / total_len
            
    return Look4mp3_result(the_best_mp3_file, score, hit_ratio)
    
referred_mp3_files = []
for a_chart in charts:
    print("")
    print(f"{a_chart['chart_title']} by {a_chart['chart_artist']} on {a_chart['date']}")
    print(pycolor.BLUE+a_chart['chart_url']+pycolor.END)
    for i, a_track in enumerate(a_chart["chart"]):
        if not a_track: continue
        look4mp3_result = look_for_mp3(a_track['artist'], a_track['title'], version=a_track['version'])
        look4mp3_result_wo_ver = look_for_mp3(a_track['artist'], a_track['title'])
        look4mp3_result_skip_dup = look_for_mp3(a_track['artist'], a_track['title'], version=a_track['version'], rm_dup=False)
        look4mp3_result_list = [ look4mp3_result, look4mp3_result_wo_ver, look4mp3_result_skip_dup]
        best_look4mp3_result = max(look4mp3_result_list, key=lambda x:x.hit_ratio*x.score)
        the_mp3_file = best_look4mp3_result.mp3_file
        score = best_look4mp3_result.score
        hit_ratio = best_look4mp3_result.hit_ratio
        if a_track['version']:
            logging.info(f"{a_track['num']:>2}------- {a_track['artist']} / {a_track['title']} ({a_track['version']})")
        else:
            logging.info(f"{a_track['num']:>2}------- {a_track['artist']} / {a_track['title']}")
        logging.info(f"({score} / {hit_ratio:3.2}){os.path.basename(the_mp3_file)}")
        
        if 0.8 <= hit_ratio:
            #if re.search(str(this_year), os.path.dirname(the_mp3_file)):
                # because new_dir ones incl. json will be moved to this_year dir. 
                # so, new and this year mp3 can be point to rerative path.
                #the_mp3_file = os.path.join(new_mp3_tracks_dir, os.path.basename(the_mp3_file))
            if re.search(os.path.join("mnt","c","Users","koich","Downloads","mp3"),the_mp3_file):
                the_mp3_file = the_mp3_file.replace(os.path.join("mnt","c","Users","koich","Downloads","mp3"), 
                                                    os.path.join("mnt","h","music",str(this_year)))
            a_track["mp3_file"] = the_mp3_file
            referred_mp3_files.append(os.path.basename(the_mp3_file))

        if hit_ratio <= 0.9 and int(a_track["num"]) <= 10:
            txt_color = pycolor.YELLOW
            if hit_ratio < 0.8: txt_color = pycolor.RED
            logging.warning(txt_color+
                            f"{a_track['num']:>2}------- {a_track['artist']} / {a_track['title']} ({a_track['version']})"+
                            pycolor.END)
            logging.warning(txt_color+
                            f"({score} / {hit_ratio:3.2}){os.path.basename(the_mp3_file)}"+
                            pycolor.END)
    
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
    album_name = get_album_dir_name(an_mp3_file)
    my_mp3_tracks["mp3_tracks"].append({"file":os.path.basename(an_mp3_file), "album":album_name})
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
        print(pycolor.YELLOW+an_unreferred_mp3_file+pycolor.END)

