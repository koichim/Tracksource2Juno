// ==UserScript==
// @name         Traxsource2Juno
// @namespace    Traxsource2Juno
// @match      https://www.traxsource.com/*
// @require 　　 https://code.jquery.com/jquery-2.0.0.min.js
// @downloadURL   https://github.com/koichim/Tracksource2Juno/raw/main/Traxsource2Juno.user.js
// @updateURL   https://github.com/koichim/Tracksource2Juno/raw/main/Traxsource2Juno.user.js
// @run-at 　　　document-end
// @grant        GM.xmlHttpRequest
// @grant        GM.openInTab
// @author       Koichi Masuda
// @version      0.13
// @description replace artist link of Traxsource to Juno's artist search
// ==/UserScript==

//(function() {
    'use strict';

    // Your code here...
    var CHECK_INTERVAL = 100; // in ms
    var JUNO_ARTIST_SERCH_HEADER = "https://www.junodownload.com/search/?facet%5Bmirror_artist_facetm%5D%5B%5D=";
    var TRAXSOURCE_URL = "https://www.traxsource.com/";
    var the_chart = {date:"", chart_artist:"", chart_title:"", chart_url:"", chart:[]};
    var debug=1;

    String.prototype.clean =function() {
        return(
            this
            .replace(/\r|\n|\t/g, "")   // 改行とタブを削除
            .trim()                     // 両端のスペースを削除
            .replace(/\s{2,}/, " ")     // 複数のスペースを1つにまとめる
        );
    }
    String.prototype.cleansing =function() {
        return(
            this
            .normalize("NFD")
            .replace(/'/, "")
            .replace(/[^a-zA-Z0-9]/g, " ")
            .clean()
        );
    }
    function artist_title_cleansing_array(str){
        str = str.cleansing();
        str = str.toLowerCase();
        let strs = str.split(/\s+/);
        strs = Array.from(new Set(strs)) // remove duplication
        let ret_strs = strs.filter(function(a_str){
            if (a_str == "" ||
                a_str == "feat" ||
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

    function look_for_mp3(artist, title, version){
        let artist_title = artist+" "+title+" "+version;
        let artist_title_words = artist_title_cleansing_array(artist_title);
        let score = 0; // smallest is the best
        let hit_ratio = 0.0;
        let the_best_mp3_file = "";
        my_mp3_tracks["mp3_tracks"].forEach(function(an_mp3){
            let tmp_artist_title_words = artist_title_words.concat();
            let filename = an_mp3["file"];
            if (an_mp3["album"] != "tracks"){
                filename = filename.replace(/^\d+ - (.+ - .+\.mp3)$/, "$1", filename);
            }
            filename = filename.replace(/\.mp3$/, "");
            let filename_words = artist_title_cleansing_array(filename)
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
        return [the_best_mp3_file, score, hit_ratio];
    }

    var my_mp3_tracks = {};
    GM.xmlHttpRequest({
        // synchronous: true, //同期処理のためのオプションだが、機能しなかったのでコメントアウトした。
        method: 'GET',
        url: 'https://masuda.sppd.ne.jp/etc/my_mp3_tracks.json',
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

    $.fn.textNodeText = function() {
        let result = "";
        $(this).contents().each(function() {
            if (this.nodeType === 3 && this.data) {
                result += jQuery.trim( $(this).text() );
            }
        });
        return result;
    };


    function run(){
        var juno_search_links = [];
        $("a.com-artists").each(function(idx, elm){
            let a = $(elm);
            if (a.attr("href").startsWith(TRAXSOURCE_URL) || !a.attr("href").startsWith("http")){
                let artist_name = a.text().replace(/ /g,"+");
                let juno_search_link = JUNO_ARTIST_SERCH_HEADER+artist_name;
                //a.attr("href", JUNO_ARTIST_SERCH_HEADER+artist_name);
                a.replaceWith("<a href=\""+juno_search_link+"\">"+a.text()+"</a>");
                console.log("Traxsource2Juno: "+a.text()+" -> "+a.attr("href"));
            }
        });
        if (!$("#download_txtfile")[0] && Object.keys(my_mp3_tracks).length != 0){
            $("[data-trid]").each(function(idx, elm){
                let num_elm = $(elm).find("div.trk-cell.tnum-pos");
                if (num_elm) {
                    let num =num_elm.text().clean();
                    let title_elm = $(elm).find("div.trk-cell.title");
                    let title = title_elm.find("a").text().clean();
                    let version = title_elm.find("span.version").textNodeText().clean();
                    let artist_elms = $(elm).find("div.trk-cell.artists").find("a").not(".com-remixers")
                    let artist = "";
                    for (let i=0; i<artist_elms.length; i++) {
                        if (0<i){artist += ", ";}
                        artist += $(artist_elms[i]).text().clean();
                    }
                    the_chart.chart[Number(num-1)] = {num: num, title:title, version:version, artist:artist};

                    let [the_mp3_file, score, hit_ratio] = look_for_mp3(artist, title, version);
                    if (0.8 < hit_ratio){
                        let num_div= $(num_elm).children("div");
                        $(num_div).html("<span title=\""+the_mp3_file+"\">&#x2714;</span>"+$(num_div).html());
                        $(num_elm).parent().css({'border-bottom':'0px'});
                        $(num_elm).parent().find('*').css({'color':'#707070'});
                        let mp3_file_div = $(num_elm).parent().clone();
                        mp3_file_div.insertAfter($(num_elm).parent());
                        mp3_file_div.html(the_mp3_file);
                        let offset_left = title_elm[0].offsetLeft; // title_elm.offset().left is absolute in the window
                        mp3_file_div.css({'height':'16px',
                                          'font-size':'10px',
                                          'vertical-align':'top',
                                          'text-indent': offset_left+'px'});

                    } else {
                        juno_search_links.push(artist_elms[0].href); // collect juno search links if no mp3 found
                    }
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
                $("h1.title").append(" (<a id='download_txtfile' download='"+filename+"'>json</a>) - ");
                $("h1.title").append($("<img src=\"https://wwwcdn.junodownload.com/14020302/images/digital/icons/favicon-32x32.png\" "+
                                       "alt=\"jd\" width=\"24\" height=\"24\" style=\"vertical-align: bottom;\"/>").on("click", function(){
                    juno_search_links.forEach(function(href, i, array){
                        let defer_time = (array.length - i)*1000
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

    var interval_id = setInterval(function(){
        run();
    },CHECK_INTERVAL);
//})();
