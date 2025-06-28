// ==UserScript==
// @name         Traxsource2Juno
// @version      0.52
// @namespace    Traxsource2Juno
// @match      https://www.traxsource.com/*
// @match      https://www.junodownload.com/*
// @match      https://masuda.sppd.ne.jp/traxsource2juno/*
// @require 　　 https://code.jquery.com/jquery-2.0.0.min.js
// @require     https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js
// @downloadURL   https://github.com/koichim/Tracksource2Juno/raw/main/Traxsource2Juno.user.js
// @updateURL   https://github.com/koichim/Tracksource2Juno/raw/main/Traxsource2Juno.user.js
// @run-at 　　　document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @author       Koichi Masuda
// @description replace artist link of Traxsource to Juno's artist search
// ==/UserScript==

//(function() {
    'use strict';

    // Your code here...
    var CHECK_INTERVAL = 500; // in ms
    var JUNO_ARTIST_SERCH_HEADER = "https://www.junodownload.com/search/?facet%5Bmirror_artist_facetm%5D%5B%5D=";
    var JUNO_ARTIST_SERCH_TRAILER = "&solrorder=date_down&list_view=tracks";
    var TRAXSOURCE_URL = "https://www.traxsource.com/";
    var the_chart = {date:"", chart_artist:"", chart_title:"", chart_url:"", chart:[]};
    var OPEN_TAB_INTERVAL = 3000; // in ms
    var debug=1;
    var my_mp3_tracks = {};
    var CLIENT_ID = "635773455630-prbo14scv7350e7juhmrl8nfu8e9pa9p.apps.googleusercontent.com";
    var GD_TOKEN_REFRESH_BEFORE_MIN = 10; // refresh 10 min beore expires
    var GD_ready_promise = new $.Deferred();
    var gdrive_icon_url="https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/web-64dp/logo_drive_2020q4_color_2x_web_64dp.png";



   function invoke_http_request(dbg_str, url, data, method, headers, funcs){
       GM_xmlhttpRequest({
           // synchronous: true, //同期処理のためのオプションだが、機能しなかったのでコメントアウトした。
           method: method,
           url: url,
           data: data,
           headers: headers,
           nocache: true,
           onload: function (response) {
               let resp_json = JSON.parse(response.responseText);
               console.log(dbg_str+": GM_xmlHttpRequest onload");
               if (funcs && funcs.onload) {funcs.onload(response);}
           },
/*           onprogress:function(response){
               console.log(dbg_str+": GM_xmlHttpRequest onprogress");
               console.log(response);
               if (funcs && funcs.onprogress) {funcs.ongrogress(response);}
           },
           onreadystatechange:function(response){
               console.log(dbg_str+": GM_xmlHttpRequest onreadystatechange");
               console.log(response);
               if (funcs && funcs.onreadystatechange) {funcs.onreadystatechange(response);}
           },*/
           onerror: function(response){
               console.log(dbg_str+": GM_xmlHttpRequest error");
               console.log(response);
              if (funcs && funcs.onerror) { funcs.onerror(response);}
           },
           onabort:function(response){
               console.log(dbg_str+": GM_xmlHttpRequest aborted");
               console.log(response);
               if (funcs && funcs.onabort) {funcs.onabort(response);}
           },
           ontimeout:function(response){
               console.log(dbg_str+": GM_xmlHttpRequest ontimeout");
               console.log(response);
               if (funcs && funcs.ontimeout) {funcs.ontimeout(response);}
           }
       });
   }

    String.prototype.clean =function() {
        return(
            this
            .replace(/\r|\n|\t/g, "")   // 改行とタブを削除
            .trim()                     // 両端のスペースを削除
            .replace(/\s{2,}/, " ")     // 複数のスペースを1つにまとめる
        );
    }
    String.prototype.cleansing =function() {
       //let tmp_str = this.normalize("NFD"); // could not normalize Obskür...
        let tmp_str = _.deburr(this);  // use lodash.deburr, instead...
        tmp_str = tmp_str.replace(/['’´]/g, "");
        tmp_str = tmp_str.replace(/[^a-zA-Z0-9]/g, " ");
        tmp_str = tmp_str.clean();
        return tmp_str;
    }
    function artist_title_cleansing_array(str, rm_dup){
        str = str.cleansing();
        str = str.toLowerCase();
        let strs = str.split(/\s+/);
        if (rm_dup) {
            strs = Array.from(new Set(strs)) // remove duplication
        }
        let ret_strs = strs.filter(function(a_str){
            if (a_str == "" ||
//                a_str == "extended" ||
                a_str == "remix" ||
                a_str == "mix" ||
                a_str == "feat" ||
//                a_str == "original" ||
                a_str == "presents" ||
                a_str == "pres"){
                return false;
            } else {
                return true;
            }
        });
        return ret_strs;
    }

    function comp_arrays_rm_match(array_i, array_j) {
        let tmp_array_i = array_i.concat();
        let tmp_array_j = array_j.concat();
        for (let i=0; i<tmp_array_i.length; i++){
            for (let j=0; j<tmp_array_j.length; j++){
                if (tmp_array_i[i] == tmp_array_j[j]){
                    array_i.splice(i,1);
                    array_j.splice(j,1);
                    return true;
                }
            }
        }
        return false;
    }

    function look_for_mp3(artist, title, version, rm_dup){
        let artist_title = artist+" "+title+" "+version;
        let artist_title_words = artist_title_cleansing_array(artist_title, rm_dup);
        let score = 0; // smallest is the best
        let hit_ratio = 0.0;
        let the_best_mp3_file = "";
        my_mp3_tracks["mp3_tracks"].forEach(function(an_mp3){
            let tmp_artist_title_words = artist_title_words.concat();
            let filename = an_mp3["file"];
            //if (an_mp3["album"] != "tracks"){
            if (filename.match(/ - /g)?.length == 2){
                filename = filename.replace(/^\d+ - (.+ - .+\.mp3)$/, "$1", filename);
            }
            filename = filename.replace(/\.mp3$/, "");
            let filename_words = artist_title_cleansing_array(filename, rm_dup)
            let total_len = filename_words.length + tmp_artist_title_words.length;
            let hit = 0;
            while (comp_arrays_rm_match(filename_words, tmp_artist_title_words)){
                hit++;
            }
            if (hit_ratio < (hit*2 / total_len)){
                score = hit;
                the_best_mp3_file = an_mp3["file"];
                if (an_mp3["album"] != "tracks"){
                    the_best_mp3_file = an_mp3["album"] + " / "+ the_best_mp3_file
            }
                hit_ratio = hit*2 / total_len;
            }
        });
        return {"the_mp3_file":the_best_mp3_file, "score":score, "hit_ratio":hit_ratio};
    }

    $.fn.textNodeText = function() {
        let result = "";
        $(this).contents().each(function() {
            if (this.nodeType === 3 && this.data) {
                result += jQuery.trim( $(this).text() );
            }
        });
        return result;
    };


    function trxsrc_run(){
        GD_set_up_and_run();

        var juno_search_links = [];
        $("a.com-artists").each(function(idx, elm){
            let a = $(elm);
            if (a.attr("href").startsWith(TRAXSOURCE_URL) || !a.attr("href").startsWith("http")){
                //let artist_name = a.text().replace(/ /g,"+");
                let artist_name_array = a.text().split(' ');
                artist_name_array.forEach(function(elm, idx){
                    artist_name_array[idx] = encodeURIComponent(elm);
                });
                let artist_name = artist_name_array.join('+');
                let juno_search_link = JUNO_ARTIST_SERCH_HEADER+artist_name+JUNO_ARTIST_SERCH_TRAILER;
                //a.attr("href", JUNO_ARTIST_SERCH_HEADER+artist_name);
                a.replaceWith("<a href=\""+juno_search_link+"\">"+a.text()+"</a>");
                console.log("Traxsource2Juno: "+a.text()+" -> "+a.attr("href"));
            }
        });
        if (!$("#download_txtfile")[0] && Object.keys(my_mp3_tracks).length != 0){
            $("[data-trid]").each(function(idx, elm){
                let num_elm = $(elm).find("div.trk-cell.tnum-pos");
                if (num_elm) {
                    if ($(num_elm).parent() &&
                        $(num_elm).parent().next() &&
                        $(num_elm).parent().next().attr('id') &&
                        $(num_elm).parent().next().attr('id').match(/^Tracksource2Juno: /)) {
                        return true; // already added. continue
                    }
                    let num =num_elm.text().clean();
                    let genre = $(elm).find("div.trk-cell.genre").text();
                    let is_classic = false;
                    if (genre.match(/classic/i)) {
                        is_classic = true;
                        $(num_elm).parent().find('*').css({'color':'#f6f600'}); // original: #f6f6f6
                    }
                    let title_elm = $(elm).find("div.trk-cell.title");
                    let title = title_elm.find("a").text().clean();
                    let version = title_elm.find("span.version").textNodeText().clean();
                    let artist_elms = $(elm).find("div.trk-cell.artists").find("a").not(".com-remixers")
                    let artist = "";
                    for (let i=0; i<artist_elms.length; i++) {
                        if (0<i){artist += ", ";}
                        artist += $(artist_elms[i]).text().clean();
                    }

                    look4mp3_results = [];
                    look4mp3_results.push(look_for_mp3(artist, title, version, true));
                    //look4mp3_results.push(look_for_mp3(artist, title, "", true)); // comment out since no version mp3 has hit with track with verion
                    look4mp3_results.push(look_for_mp3(artist, title, version, false));
                    let max_score_x_hit_ratio = 0;
                    let max_indx = 0; // default with version and rm_dup=true

                    look4mp3_results.forEach(function(a_look4mp3_result, indx){
                        let score_x_hit_ratio = a_look4mp3_result.score * a_look4mp3_result.hit_ratio;
                        if (max_score_x_hit_ratio < score_x_hit_ratio){
                            max_score_x_hit_ratio = score_x_hit_ratio;
                            max_indx = indx;
                        }
                    });
                    let the_mp3_file = look4mp3_results[max_indx].the_mp3_file
                    let score = look4mp3_results[max_indx].score;
                    let hit_ratio = look4mp3_results[max_indx].hit_ratio;
                    if (0.6 <= hit_ratio){
                        $(num_elm).parent().css({'border-bottom':'0px'});
                        let mp3_file_div = $(num_elm).parent().clone();
                        mp3_file_div.html("["+String(Math.trunc(hit_ratio*100))+"%] "+the_mp3_file);
                        let mp3_file_color = '#ccc';
                        if (0.9 <= hit_ratio) {
                            let num_div= $(num_elm).children("div");
                            //$(num_div).html("<span title=\""+the_mp3_file+"\">&#x2714;</span>"+$(num_div).html()); // check mark
                            $(num_div).html("&#x2714;"+$(num_div).html()); // check mark
                            $(num_elm).parent().find('*').css({'color':'#707070'}); // gray out
                            mp3_file_color = '#707070';
                            if (1 != hit_ratio) {
                                mp3_file_div.html("<font color=\"white\">["+String(Math.trunc(hit_ratio*100))+"%]</font> "+the_mp3_file);
                            }
                        } else if (0.8 <= hit_ratio) {
                            mp3_file_color = '#cc9';
                        } else if (0.7 <= hit_ratio) {
                            mp3_file_color = '#cc0';
                        } else if (0.6 <= hit_ratio) {
                            mp3_file_color = '#c00';
                        }
                        if (is_classic) {
                            $(num_elm).parent().find('*').css({'color':'#707000'});
                        }
                        mp3_file_div.insertAfter($(num_elm).parent());
                        let offset_left = title_elm[0].offsetLeft; // title_elm.offset().left is absolute in the window
                        mp3_file_div.css({'height':'16px',
                                          'font-size':'10px',
                                          'vertical-align':'top',
                                          'color':mp3_file_color,
                                          'text-indent': offset_left+'px'});
                        mp3_file_div.attr('id', "Tracksource2Juno: "+the_mp3_file);

                    }
                    if (hit_ratio < 0.9 && num <= 10) {
                        if (artist_elms && artist_elms[0] && artist_elms[0].href) {
                            juno_search_links.push(artist_elms[0].href); // collect juno search links if no mp3 found
                        }
                    }
                    // for download chart json
                    let the_mp3_file_4json = the_mp3_file;
                    if (hit_ratio < 0.8) {
                        the_mp3_file_4json = ""; // regard as not found
                    }
                    if (hit_ratio != 1 && num <= 10){
                        GD_search(artist + " " + title + " " + version, num_elm);
                    }
                    the_chart.chart[Number(num-1)] = {num: num, title:title, version:version, artist:artist, mp3_file:the_mp3_file_4json};
                }
            });
            if (the_chart.chart.length) {
                let rdate = $("div.cat-rdate").text();
                the_chart.date = rdate.substr(rdate.indexOf("|")+1).clean();
                the_chart.chart_artist = $("h1.artists").text().clean();
                the_chart.chart_title = $("h1.title").text().clean();
                the_chart.chart_url = location.href;
                let filename = the_chart.date + "_" + the_chart.chart_artist.cleansing() + "_" + the_chart.chart_title.cleansing() + ".json";
                let encoded_chart = encodeURIComponent(JSON.stringify(the_chart, null, 2));
                $("h1.title").prepend(" (<a id='download_txtfile' download='"+filename+"'>json</a>) ");
                $("h1.title").append(" - ");
                $("h1.title").append($("<img src=\"https://wwwcdn.junodownload.com/14020302/images/digital/icons/favicon-32x32.png\" "+
                                       "alt=\"jd\" width=\"24\" height=\"24\" style=\"vertical-align: bottom;\"/>").on("click", function(){
                    juno_search_links.forEach(function(href, i, array){
                        let defer_time = (array.length - i)*OPEN_TAB_INTERVAL;
                        setTimeout(function(){
                            console.log("open "+href);
                            GM.openInTab(href, true);
                        }, defer_time);
                    });
                }));
                $("#download_txtfile").on("click", function() {
                    //this.href = `data:application/json;charset=UTF-8,${JSON.stringify({massage:encoded_chart})}`;
                    this.href = `data:application/json;charset=UTF-8,${encoded_chart}`;
                });
                console.log(my_mp3_tracks);
            }
                        let npbtns = $(".np-btns .share.embed");
            if (npbtns.length) {
                //npbtns.after("<img src=\"https://wwwcdn.junodownload.com/14020302/images/digital/icons/favicon-32x32.png\" />");
                npbtns.after("<span>jd</span>");
            }

        }
    }

    function GD_poll_ready(){
        let GD_interval_id = setInterval(() => {
            let GD_auth_code = GM_getValue("GD_auth_code");
            let now = new Date();
            if (GD_auth_code && now.getTime() + GD_TOKEN_REFRESH_BEFORE_MIN*60*1000 < GD_auth_code.expires_at) {
                // OK, go ahead!
                console.log("got GD auth_code");
                console.log(GD_auth_code);
                clearInterval(GD_interval_id);
                $("#Traxsource2Juno_enableGDsearch").css({filter:"grayscale(0%)"});
                GD_ready_promise.resolve();
            }
        },CHECK_INTERVAL);

    }
    function GD_set_up_and_run(){
        if (!$("#Traxsource2Juno_enableGDsearch")[0]){
            if ($("#bodyBay")[0] && $("#bodyBay").find(".sharebox-inline")){
                $("#bodyBay").find(".sharebox-inline").append(
                    "<img id=\"Traxsource2Juno_enableGDsearch\" "+
                    "style=\"\overflow:visible; width:26px; height:26px; filter:grayscale(100%);\" "+
                    "src=\""+gdrive_icon_url+"\"/>");
                GD_poll_ready();
                $("#Traxsource2Juno_enableGDsearch").on("click", () => {
                    GD_get_auth_code_in_tab();
                });
            }
        }
    }
    function GD_search(search_str, num_elm){
        console.log(search_str);
        let words = artist_title_cleansing_array(search_str, true);
        let q = "";
        words.forEach((a_word) => {
            if (q) {q+=" and ";}
            q += "name contains '" + a_word+"'";
        });
        q += " and mimeType = 'audio/mpeg'";
        console.log("GD_search: "+q);
        q = encodeURIComponent(q);
        $.when(GD_ready_promise).done(()=>{
            /* https://www.mii47.com/entry/2025/03/09/212911
        curl -X GET 'https://www.googleapis.com/drive/v3/files?q='"'"'[フォルダID]'"'"'+in+parents+and+trashed=false&supportsAllDrives=true&includeItemsFromAllDrives=true' \
        -H "Authorization: Bearer [トークン]"
        google reference: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list?hl=ja
        ファイルやフォルダを検索する - https://developers.google.com/workspace/drive/api/guides/search-files?hl=ja
        */
            let GD_auth_code = GM_getValue("GD_auth_code");
            let folder_id = "1unILTVnIhi3VsrSWFrOomNAlVM-Fqu9v"; // music_backup folder
            let headers = {
                "Content-Type": "application/json",
                "Authorization": "Bearer "+GD_auth_code.access_token,
            }
            let funcs = {onload: (res) => {
                res_json = JSON.parse(res.responseText);console.log(res_json);
                if (res_json.files.length) {
                    $(num_elm).css({"background-image": "url('"+gdrive_icon_url+"')",
                                   "background-size": "contain",
                                   "background-repeat": "no-repeat",
                                   "background-position": "center",
                                   "mix-blend-mode": "exclusion"});
                    $(num_elm).attr("title",res_json.files[0].name);

                }
            },
                        };
            invoke_http_request("GD_search "+search_str,
                                "https://www.googleapis.com/drive/v3/files?q="+q,
                                "",
                                "GET",
                                headers,
                                funcs);
        });
    }

    function GD_get_auth_code_in_tab(){
       /* https://accounts.google.com/o/oauth2/auth?client_id=[クライアントID]&
          redirect_uri=https://localhost:8080&
          scope=https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata&
          response_type=code&
          access_type=offline
        */
        //GM_setValue("GD_auth_code",""); // debug
        let GD_auth_code = GM_getValue("GD_auth_code");
        let now = new Date();
        if (GD_auth_code && now.getTime() + GD_TOKEN_REFRESH_BEFORE_MIN*60*1000 < GD_auth_code.expires_at) {
            // OK, go ahead!
            console.log("already have GD auth_code="+GD_auth_code);
            return;
        }
        GM_setValue("GD_auth_code","");
        let redirect_uri = encodeURIComponent("https://masuda.sppd.ne.jp/traxsource2juno/");
        let scope = encodeURIComponent("https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly");
        let url = " https://accounts.google.com/o/oauth2/v2/auth?client_id="+CLIENT_ID+"&"+
            "redirect_uri="+redirect_uri+"&"+
            "scope="+scope+"&"+
            "response_type=token";
            //"&access_type=offline";
        console.log("GD_move_and_get_auth_code: open google auth page");
        let tab_control = GM_openInTab(url);
        let GD_interval_id = setInterval(() => {
            GD_auth_code = GM_getValue("GD_auth_code");
            if (GD_auth_code) {
                console.log("got GD auth_code");
                console.log(GD_auth_code);
                clearInterval(GD_interval_id);
                tab_control.close();
                // OK, go ahead!
            }
        },CHECK_INTERVAL);

    }

    /*
    * masuda.sppd page
    */
    function getParam(name, url) {
        if (!url) url = window.location.href;
        name = name.replace(/[\[\]]/g, "\\$&");
        var regex = new RegExp("[#?&]" + name + "(=([^&#]*)|&|#|$)"),
            results = regex.exec(url);
        if (!results) return null;
        if (!results[2]) return '';
        return decodeURIComponent(results[2].replace(/\+/g, " "));
    }
    function GD_get_auth_code_run(){
        /* http://masuda.sppd.ne.jp/traxsource2juno/?code=[Authorization Code]&
           scope=https://www.googleapis.com/auth/drive%20https://www.googleapis.com/auth/drive.metadata
         */
        let auth_code = {access_token: "",
                         expires_in: "",
                         scope:""};
        $.each(auth_code, (key, value) => auth_code[key] = getParam(key));
        if (!auth_code.access_token){
            $("body").html("getting auth code failed.<br/>url is "+window.location.href);
        }
        auth_code.expires_at = new Date().getTime() + auth_code.expires_in*1000;
        console.log("got GD auth_code");
        console.log(auth_code);
        GM_setValue("GD_auth_code", auth_code);
    }
    /*
    * Juno page
    */
    function add_trxsrc_link(parent_node, search_text){
        let search_title = search_text.replace(/\s+/g, "+");
        parent_node.append(" <a href=\"https://www.traxsource.com/search?term="+search_title+"\"><img style=\"width:23px; height:23px; filter: grayscale(100%);\"src=\"https://www.traxsource.com/logos-and-images/logo-icon.png\"/></a>");
    }
    function juno_run(){
        if ($(".juno-title")[0]){
            $(".juno-title").each(function(i, title_node){
                if ($(title_node).parent().children().length == 1) {
                    add_trxsrc_link($(title_node).parent(), title_node.innerText);
                }
            });
        }
        if ($(".product-title")[0]){
            $(".product-title").each(function(i, title_node){
                if ($(title_node).children().length == 1) {
                    add_trxsrc_link($(title_node), title_node.innerText);
                }
            });
        }
    }

    if (location.href.match(/masuda.sppd.ne.jp\/traxsource2juno\//i)){
        GD_get_auth_code_run();
    } else if (location.hostname.match(/traxsource.com$/i)){
        let funcs = {
            onload: (response) => {
                my_mp3_tracks = JSON.parse(response.responseText);
            }
        }
        invoke_http_request("getting my_mp3_tracks",
                     "https://masuda.sppd.ne.jp/etc/my_mp3_tracks.json",
                     "", // data
                     "GET",
                     {"Content-Type": "application/json"}, //headers
                     funcs);
    }
/*
    GM.xmlHttpRequest({
        // synchronous: true, //同期処理のためのオプションだが、機能しなかったのでコメントアウトした。
        method: 'GET',
        url: 'https://masuda.sppd.ne.jp/etc/my_mp3_tracks.json',
        nocache: true,
        onload: function (response) {
            my_mp3_tracks = JSON.parse(response.responseText);
        },
        onprogress:function(response){
            console.log("GM.xmlHttpRequest: onprogress");
            console.log(response);
        },
        onreadystatechange:function(response){
            console.log("GM.xmlHttpRequest: onreadystatechange");
            console.log(response);
        },
        onerror: function(response){
            console.log("GM.xmlHttpRequest: error");
            console.log(response);
        },
        onabort:function(response){
            console.log("GM.xmlHttpRequest: aborted");
            console.log(response);
        },
        ontimeout:function(response){
            console.log("GM.xmlHttpRequest: ontimeout");
            console.log(response);
        }
    });
*/
    var interval_id = setInterval(function(){
        if (location.hostname.match(/traxsource.com$/i)){
            trxsrc_run();
        } else if (location.hostname.match(/junodownload.com$/i)){
            juno_run();
        }
    },CHECK_INTERVAL);
//})();
