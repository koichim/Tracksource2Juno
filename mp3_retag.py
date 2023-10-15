#!/usr/bin/python3

import sys
import os
import shutil
import re
import logging
from mutagen.id3 import ID3,APIC,TRCK,TPE1,TIT2
from io import BytesIO
from PIL import Image
import unicodedata


logging.basicConfig(stream=sys.stderr, level=logging.ERROR)

# todo: delayed stderr
# str = "Silence (feat Sarah McLachlan - Stone Van Brooken, Pete K extended mix)"
# fixed = re.sub(r"(\(feat[^\)]+?) - (.+?\))", r"\1) (\2", str)
# print(fixed)
# sys.exit()

tag_update = False
tracks_dir = "tracks"
traxsource_dir = "traxsource"
id3tag_tracknumber = "TRCK"
id3tag_artist = "TPE1"
id3tag_title = "TIT2"

warning_strings = []
#mp3_dir = ["./AC_Soul_Symphony_Dave_Lee_ZR_-_I_Want_To_See_You_Dance___The_Philly_Avengers_-_Z_Records"]
mp3_dir = [traxsource_dir]

def normalize_unicode(words: str) -> str:
    unicode_words = ""
    for character in unicodedata.normalize("NFD", words):
        if unicodedata.category(character) != "Mn":
            unicode_words += character
    return unicode_words

argv = sys.argv
argv.pop(0) # this is the script name
while argv:
    arg = argv.pop(0) 
    if arg == "-u":
        print("Is it OK to modify tag (y ot n):",end="")
        answer = input()
        if answer == 'y':
            tag_update = True
        else:
            logging.error(f"wrong answer {answer}. exiting...")
            sys.exit()
    elif arg == "-v":
        verbose = True
    else:
        mp3_dir.append(arg)

if len(mp3_dir) == 0:
    logging.error("need to specify directory including mp3 files.")
    sys.exit()

# my %supported_frames = (
#     TDAT => 1, #1302
#     #APIC => 1, #HASH(0x2b139d8)
#     TYER => 1, #2017
#     TPE1 => 1, #Byron Stingily
#     TSRC => 1, #GBVVQ1025533
#     WPUB => 1, #PMI Dance
#     TCOP => 1, #(C) Phoenix Music International 2012
#     TPE2 => 1, #VARIOUS
#     TALB => 1, #Club SuSu On The Rocks
#     TRCK => 1, #13
#     TPUB => 1, #PMI Dance
#     TIT2 => 1, #U Turn Me (feat. Lee John) (Urban Groove 21st Century dub)
#     TCON => 1, #Funky/vocal/disco/club house
#     #UFID => 1, #HASH(0x2b214b0)
#     TBPM => 1, #128
#       );
# my @warning_strings = ();

# my @supported_frames = keys %supported_frames;

for an_mp3_dir in mp3_dir:
    print("=======================")
    if not os.path.isdir(an_mp3_dir):
        print(f"{an_mp3_dir} is not DIR name. Skip.")
        continue
    print(f"DIR: {an_mp3_dir} ")
    print("=======================")

    #collecting the files
    mp3_files = []
    cover_jpg_file = ""
    files = os.listdir(an_mp3_dir)
    for a_file in files:
        if os.path.splitext(a_file)[1] == ".mp3":
            mp3_files.append(os.path.join(an_mp3_dir,a_file))
            logging.debug(f"{a_file} is added in queue")
        elif os.path.splitext(a_file)[1] == ".jpg":
            cover_jpg_file = os.path.join(an_mp3_dir,a_file)

    # open the cover image jpg here
    if cover_jpg_file:
        cover_img_from_file = Image.open(cover_jpg_file) 

    # extract tags from the mp3 file
    for an_mp3_file in mp3_files:
        if not os.path.isfile(an_mp3_file):
            logging.error(f"{an_mp3_file} does not exist")
            continue
        
        tags = ID3(an_mp3_file)
        logging.debug(f"ID3 version: {tags.version}")
        for key, value in tags.items():
            logging.debug(tags.get(key).pprint())
                
        cur_tracknumber = tags.get(id3tag_tracknumber).text[0]
        cur_artist = tags.get(id3tag_artist).text[0]
        cur_title = tags.get(id3tag_title).text[0]
        
        tmp_tracknumber = "00"
        tmp_artist = ""
        tmp_title = ""
        if cur_tracknumber:
            tmp_tracknumber = cur_tracknumber
        if cur_artist:
            tmp_artist = cur_artist
        if cur_title:
            tmp_title = cur_title
        
        need_fix = False
        if not cur_tracknumber or not cur_artist or not cur_title:
            print(f"BAD ID3 tag found: {an_mp3_file}")
            print(f"       #: {cur_tracknumber}")
            print(f"  artist: {cur_artist}")
            print(f"   title: {cur_title}")
            need_fix = True
        else:
            logging.info(f"ID3 tag found: {an_mp3_file}")
            logging.info(f"       #: {cur_tracknumber}")
            logging.info(f"  artist: {cur_artist}")
            logging.info(f"   title: {cur_title}")
        
        if cur_title and \
            (re.search(r"[\( ]feat ", cur_title) or \
            re.search(r"\(feat[^\)]+? - .+?\)", cur_title) or \
            re.search(r"\(.+? - feat[^\)]+?\)", cur_title)):
            tmp_title = re.sub(r"(\(feat[^\)]+?) - (.+?\))", r"\1) (\2", tmp_title)
            tmp_title = re.sub(r"(\(.+?) - (feat[^\)]+?\))", r"(\2 \1)", tmp_title)
            tmp_title = re.sub(r"([\( ])feat ", r"\1feat. ", tmp_title)
            need_fix = True
        
        if cur_artist and \
            re.search(r"[\( ]feat ", cur_artist):
            tmp_artist = re.sub(r"([\( ])feat ", r"\1feat. ", tmp_artist)
            need_fix = True
            
        if cur_tracknumber and \
            re.search(r"^\d$", cur_tracknumber):
            tmp_tracknumber = f"{cur_tracknumber:0>2}"
            need_fix = True
        
        #need_fix = True #debug
        # extract the data from file name
        if need_fix:
            artist_title = os.path.basename(an_mp3_file)
            artist_title = re.sub(r"\.mp3$", "", artist_title)
            artist_title = re.sub(r"___", "_&_", artist_title)
            artist_title = re.sub(r"(\(feat[^\)]+?)_-_(.+?\))", r"\1) (\2", artist_title)
            artist_title = re.sub(r"(\(.+?)_-_(feat[^\)]+?\))", r"(\2 \1)", artist_title)
            artist_title = re.sub(r"([_\(])feat_", r"\1feat._", artist_title)
            artist_title = re.sub(r"_presents_", r"_pres._", artist_title, flags=re.IGNORECASE)
            artist_title = re.sub(r"_dj_", "_DJ_", artist_title, flags=re.IGNORECASE)
            artist_title = re.sub(r"_", " ", artist_title)
            
            tmp_tags = artist_title.split('-')
            if an_mp3_dir == traxsource_dir:
                if len(a_tag) != 2: # Joy Marquez, Havana Hustlers - Lady (Hear Me Tonight) (Original Drum Mix).mp3
                    logging.error(f"maybe bad parsing artist_title from traxsource filename: {os.path.basename(an_mp3_file)}")
            else:
                if len(tmp_tags) != 4: # 03-Miguel_Migs_feat_Martin_Luther_-_Back_Tonight_(Lovebirds_Disco_Sketch_extended_mix)-320kb_s_MP3.mp3
                    logging.error(f"maybe bad parsing artist_title from juno filename: {os.path.basename(an_mp3_file)}")
                    
            for i, a_tag in enumerate(tmp_tags):
                a_tag = re.sub(r"^\s+", "", a_tag)
                a_tag = re.sub(r"\s+$", "", a_tag)
                if an_mp3_dir == traxsource_dir:
                    if i==0 and not tmp_artist:
                        tmp_artist = a_tag
                    elif not tmp_title:
                        tmp_title = a_tag
                else:
                    if i==0 and not tmp_tracknumber:
                        tmp_tracknumber = a_tag
                    elif i==1 and not tmp_artist:
                        tmp_artist = a_tag
                    elif re.search(r"^320kb s MP3$", a_tag):
                        break
                    elif not tmp_title:
                        tmp_title = a_tag
                
            tmp_title = re.sub(r"(\(feat[^\)]+?) - (.+?\))", r"\1) (\2", tmp_title)
            tmp_title = re.sub(r"(\(.+?) - (feat[^\)]+?\))", r"(\2 \1)", tmp_title)
            tmp_title = re.sub(r"([\( ])feat ", r"\1feat. ", tmp_title)
            tmp_artist = re.sub(r"([\( ])feat ", r"\1feat. ", tmp_artist)
            
            # how to put the values in mutagen ID3 tags
            # https://stackoverflow.com/questions/71468239/function-to-write-id3-tag-with-python-3-mutagen
            tags[id3tag_tracknumber] = TRCK(encoding=3, text=u''+tmp_tracknumber+'')
            tags[id3tag_artist] =  TPE1(encoding=3, text=u''+tmp_artist+'')
            tags[id3tag_title] = TIT2(encoding=3, text=u''+tmp_title+'')
            
            if tag_update:
                print("FIXING:")
            else:
                print("fix proposal:")
                
            if cur_tracknumber == tags.get(id3tag_tracknumber).text[0]:
                print(f"       #: {cur_tracknumber}")
            else:
                print(f"       #: {cur_tracknumber} ---> {tags.get(id3tag_tracknumber).text[0]}")
                
            print(f"  artist: {cur_artist}")
            if cur_artist != tags.get(id3tag_artist).text[0]:
                print(f"     ---> {tags.get(id3tag_artist).text[0]}")
                
            print(f"   title: {cur_title}")
            if cur_title != tags.get(id3tag_title).text[0]:
                print(f"     ---> {tags.get(id3tag_title).text[0]}")            
        
        #Fixing the cover image
        need_fix_img = False
        apic_id3tag = "APIC:"
        apic = tags.get(apic_id3tag)
        if apic is None:
            apic_id3tag = "APIC:Cover Image"
            apic = tags.get(apic_id3tag)
        
        cover_img_in_mp3 = None
        if apic is None:
            logging.warning(f"no APIC in {an_mp3_file}")
            need_fix_img = True
        else:
            cover_img_in_mp3 = Image.open(BytesIO(apic.data))
            if cover_img_in_mp3.size[0] < 500 or cover_img_in_mp3.size[1] < 500:                    
                need_fix_img = True
            else:
                logging.debug(f"no need ti fix coer image. current size={cover_img_in_mp3.size}")
        
        if not re.search(r"^[\x20-\x7E\s]+$", tags.get(id3tag_artist).text[0]) or \
            not re.search(r"^[\x20-\x7E\s]+$", tags.get(id3tag_title).text[0]) or \
            re.search(r"\?", tags.get(id3tag_artist).text[0]) or \
            re.search(r"\?", tags.get(id3tag_title).text[0]) or \
            not re.search(r"^[\x20-\x7E\s]+$", os.path.basename(an_mp3_file)):
                warning_strings.append(f"{an_mp3_file}: \"{tags.get(id3tag_title).text[0]}\" / {tags.get(id3tag_artist).text[0]}")
        
        #move to mp3 dir
        if tag_update: #                 tags.save()
            
            artist_in_filename = re.sub(r'[\\|/|:|?|"|<|>|\|]', "_", tags.get(id3tag_artist).text[0])
            title_in_filename = re.sub(r'[\\|/|:|?|"|<|>|\|]', "_", tags.get(id3tag_title).text[0])
            artist_in_filename = normalize_unicode(artist_in_filename)
            title_in_filename = normalize_unicode(title_in_filename)
            if re.search(traxsource_dir+r"$", an_mp3_dir) or len(mp3_files) < 3:  # assuming tracks
                new_mp3_dir = os.path.join(tracks_dir, "mp3")
                new_img_dir = os.path.join(tracks_dir, "cover")
                new_mp3_filename = f"{artist_in_filename} - {title_in_filename}.mp3"
                new_img_filename = f"{artist_in_filename} - {title_in_filename}.jpg"                
                
            else: # assuming album
                new_mp3_dir = os.path.join(an_mp3_dir, "mp3")
                new_img_dir = an_mp3_dir
                new_mp3_filename = f"{tags.get(id3tag_tracknumber).text[0]:0>2} - {artist_in_filename} - {title_in_filename}.mp3"
                new_img_filename = f"cover.jpg"
                
            os.makedirs(new_mp3_dir, exist_ok=True) # this can make deep also for mp3/ or tacks/mp3/
            os.makedirs(new_img_dir, exist_ok=True) # this can make deep also for mp3/ or tacks/cover/
            
            # move/save cover image
            if not os.path.exists(os.path.join(new_img_dir, new_img_filename)):
                if cover_jpg_file:
                    try:
                        shutil.move(cover_jpg_file, new_img_dir) # keep original at new dir
                    except:
                        pass
                    if cover_img_from_file.size[0] < 500 or cover_img_from_file.size[1] < 500:
                        logging.error(f"cannot fix img...bad jpg file: {cover_jpg_file}.size={cover_img_from_file.size}")
                        need_fix_img = False
                    else:
                        cover_img_from_file = cover_img_from_file.resize((500, 500))
                        cover_img_from_file.save(os.path.join(new_img_dir, new_img_filename))
                elif cover_img_in_mp3:
                    # since no cover file provided, this should be the max size and will not need_fix_img
                    #cover_img_in_mp3.save(os.path.join(new_img_dir, os.path.splitext(new_img_filename)[0]+"_org.jpg")) #original just from mp3
                    #cover_img_in_mp3 = cover_img_in_mp3.resize((500, 500))
                    cover_img_in_mp3.save(os.path.join(new_img_dir, new_img_filename))
                else:
                    logging.error(f"cannot fix img...no cover info to fix for {an_mp3_file}")
                    need_fix_img = False
            
            # fix cover image in the mp3 file
            if need_fix_img:
                with open(os.path.join(new_img_dir, new_img_filename), "rb") as img_file_fd:
                    cover_img_byte_str = img_file_fd.read()
                tags.delall(apic_id3tag)
                tags.add(APIC(mime="image/jpeg", type=3, data=cover_img_byte_str))

            if need_fix or need_fix_img:
                tags.save()
            
            #move the track to mp3/
            shutil.move(an_mp3_file, os.path.join(new_mp3_dir, new_mp3_filename))
    
    #remove the dir if empty, assuming track from juno
    if tag_update:
        if not os.path.basename(an_mp3_dir) == "traxsource":
            try:
                os.removedirs(an_mp3_dir)
            except OSError as e:
                logging.debug(f"could not remove the dir {an_mp3_dir}: {e}")

    if os.path.exists(an_mp3_dir) and \
        not os.path.basename(an_mp3_dir) == traxsource_dir and \
        re.search(r"^[\S]+$", an_mp3_dir):
        new_dir = re.sub(r"_", " ", an_mp3_dir)
        if tag_update:
            print(f"renaming dir: {an_mp3_dir} -> {new_dir}")
            os.rename(an_mp3_dir, new_dir)
        else:
            print(f"renaming dir proposal: {an_mp3_dir} -> {new_dir}")

if len(warning_strings):
    print("!!!!!!!!!!!!!!!!!!!!!!!!")
    print("non-ASCII strings or '?' is included in...")
    for a_warning in warning_strings:
        print(a_warning)
    print("!!!!!!!!!!!!!!!!!!!!!!!!")