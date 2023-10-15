#!/usr/local/bin/perl --

BEGIN {
    push(@INC, "../perl-modules/");
}

use strict;
use Data::Dumper;
use MP3::Tag;
use utf8;

$|=1; # no buffering

my $tag_update = 0;
my $verbose = 0;

while ($ARGV[0] =~ /^-.$/) {
    my $opt = shift @ARGV;
    if ($opt eq "-u") {
	print "Is it OK to modify tag (y ot n):";
	my $answer = <STDIN>;
	chomp($answer);
	if ($answer =~ /^y$/i || $answer =~ /^yes$/i) {
	    $tag_update = 1;
	} else {
	    die "exiting...\n";
	}
    } elsif ($opt eq "-v") {
	$verbose = 1;
    }
}

if (@ARGV == 0) {
    die "need to specify directory including mp3 files.\n";
}


my %supported_frames = (
    TDAT => 1, #1302
    #APIC => 1, #HASH(0x2b139d8)
    TYER => 1, #2017
    TPE1 => 1, #Byron Stingily
    TSRC => 1, #GBVVQ1025533
    WPUB => 1, #PMI Dance
    TCOP => 1, #(C) Phoenix Music International 2012
    TPE2 => 1, #VARIOUS
    TALB => 1, #Club SuSu On The Rocks
    TRCK => 1, #13
    TPUB => 1, #PMI Dance
    TIT2 => 1, #U Turn Me (feat. Lee John) (Urban Groove 21st Century dub)
    TCON => 1, #Funky/vocal/disco/club house
    #UFID => 1, #HASH(0x2b214b0)
    TBPM => 1, #128
      );
my @warning_strings = ();

my @supported_frames = keys %supported_frames;

for (my $j=0; $j<@ARGV; $j++) {
    print "=======================\n";
    if (!(-d $ARGV[$j])) {
	print $ARGV[$j], " is not DIR name. Skip.\n";
	next;
    }
    print "DIR: ", $ARGV[$j], "\n";
    print "=======================\n";

    my $file;
    my @mp3_files;
    opendir(DIR, $ARGV[$j]);
    while ($file = readdir(DIR)) { 
	if ($file =~ /.mp3$/i) {
	    push(@mp3_files, $file); 
	    if ($verbose) {
		print $file." is added in queue\n";
	    }
	}
    }
    closedir(DIR);
    
    
    foreach (@mp3_files) {
	my $a_mp3_file = $ARGV[$j]."/".$_;

	if (!(-f $a_mp3_file)) { warn $_." does not exist"; next;}
	my $mp3 = MP3::Tag->new($a_mp3_file);
	my $tag = {};
	my $ID3info = "";
	my $need_fix = 0;
	$mp3->get_tags();
	if (exists $mp3->{ID3v2})
	{
	    $ID3info = "ID3v2";
	    my $id3v2 = $mp3->{ID3v2};
	    my $frames = $id3v2->supported_frames();
	    while (my ($fname, $longname) = each %$frames)
	    {
		# only grab the frames we know
		next unless exists $supported_frames{$fname};
		$tag->{$fname} = $id3v2->get_frame($fname);
		delete $tag->{$fname} unless defined $tag->{$fname};
		$tag->{$fname} = '' unless defined $tag->{$fname};
	    } 
	    if ($tag->{TRCK} eq "" || $tag->{TPE1} eq "" || $tag->{TIT2} eq "") {
		$need_fix = 1;
	    } 
	    if ($need_fix) {
		print "BAD ", $ID3info, " found: ",$_, "\n";
		print "       #: ", $tag->{TRCK}, "\n";
		print "  artist: ", $tag->{TPE1}, "\n";
		print "   title: ", $tag->{TIT2}, "\n";
	    } else {
		if ($verbose) {print $ID3info, " found: ",$_, "\n";}
		if ($verbose) {print "       #: ", $tag->{TRCK}, "\n";}
		if ($verbose) {print "  artist: ", $tag->{TPE1}, "\n";}
		if ($verbose) {print "   title: ", $tag->{TIT2}, "\n";}
	    }
	} elsif (exists $mp3->{ID3v1}) {
	    $ID3info = "ID3v1";
	    my $id3v1 = $mp3->{ID3v1};
	    $tag->{COMM} = $id3v1->comment();
	    $tag->{TIT2} = $id3v1->song();
	    $tag->{TPE1} = $id3v1->artist();
	    $tag->{TALB} = $id3v1->album();
	    $tag->{TYER} = $id3v1->year();
	    $tag->{TRCK} = $id3v1->track();
	    $tag->{TIT1} = $id3v1->genre();
	    if ($tag->{TRCK} eq "" || $tag->{TPE1} eq "" || $tag->{TIT2} eq "") {
		$need_fix = 1;
	    }
	    if ($need_fix) {
		print "BAD ", $ID3info, " found: ",$_, "\n";
		print "       #: ", $tag->{TRCK}, "\n";
		print "  artist: ", $tag->{TPE1}, "\n";
		print "   title: ", $tag->{TIT2}, "\n";
	    } else {
		if ($verbose) {print $ID3info, " found: ",$_, "\n";}
		if ($verbose) {print "       #: ", $tag->{TRCK}, "\n";}
		if ($verbose) {print "  artist: ", $tag->{TPE1}, "\n";}
		if ($verbose) {print "   title: ", $tag->{TIT2}, "\n";}
	    }
	} else {
	    print $_." does not have ID3v2/1 tag...\n";
	    $need_fix = 1;
	}

	$mp3->close();

	if ($tag->{'TIT2'} =~ /([\( ])feat / ||
	    $tag->{'TPE1'} =~ /([\( ])feat / ||
	    $tag->{'TIT2'} =~ /(\(feat[^\)]+?) - (.+?\))/ ||
	    $tag->{'TIT2'} =~ /\((.+?) - (feat[^\)]+?\))/) {
	    $need_fix = 1;
	}

	if ($need_fix) {
	    #my $info_hashref = $mp3->autoinfo;
	    my $artist_title = $_;
	    $artist_title =~ s/\.mp3$//;
	    $artist_title =~ s/___/_&_/g;
	    $artist_title =~ s/(\(feat[^\)]+?)_-_(.+?\))/$1\) \($2/g;
	    $artist_title =~ s/(\(.+?)_-_(feat[^\)]+?\))/\)$2 $1\)/g;
	    $artist_title =~ s/([_\(])feat_/$1feat._/g;
	    $artist_title =~ s/_presents_/_pres\._/ig;
	    $artist_title =~ s/_dj_/_DJ_/ig;
	    $artist_title =~ s/_/ /g;
	    my $tmp_title = "";
	    my $tmp_artist = "";
	    my $tmp_track = 0;
	    my @tmp_tags = split(/-/, $artist_title);
	    for (my $i=0; $i<@tmp_tags-1; $i++) {
		$tmp_tags[$i] =~ s/^ //;
		$tmp_tags[$i] =~ s/ $//;
		if (0 == $i) {$tmp_track = $tmp_tags[0];} # track number
		elsif (1 == $i) {$tmp_artist = $tmp_tags[1];}
		elsif ($tmp_tags[$i] =~ /^320kb s MP3$/) {last;}
		else {
		    $tmp_title .= $tmp_tags[$i];
		}
	    }
	    if ($tag->{'TIT2'} eq "") { #title
		$tag->{'TIT2'} = $tmp_title;
	    }
	    if ($tag->{'TPE1'} eq "") {
		$tag->{'TPE1'} = $tmp_artist; #artist
	    }
	    if ($tag->{'TRCK'} eq "") {
		$tag->{'TRCK'} = $tmp_track;
	    }
	    
	    $tag->{'TIT2'} =~ s/(\(feat[^\)]+?) - (.+?\))/$1\) \($2/g;
	    $tag->{'TIT2'} =~ s/(\(.+?) - (feat[^\)]+?\))/\($2 $1\)/g;
	    $tag->{'TIT2'} =~ s/([\( ])feat /$1feat. /;
	    $tag->{'TPE1'} =~ s/([\( ])feat /$1feat. /;

	    if ($tag_update) {
		print "FIXING:\n";
		print "       #: ", $tag->{TRCK}, "\n";
		print "  artist: ", $tag->{TPE1}, "\n";
		print "   title: ", $tag->{TIT2}, "\n";
		set_tag($a_mp3_file, $tag);
	    } else {
		print "fix proposal:\n";
		print "       #: ", $tag->{TRCK}, "\n";
		print "  artist: ", $tag->{TPE1}, "\n";
		print "   title: ", $tag->{TIT2}, "\n";
	    }
	}

	if ($tag->{'TPE1'} !~ /^[\x20-\x7E\s]+$/ ||
	    $tag->{'TIT2'} !~ /^[\x20-\x7E\s]+$/ ||
	    $a_mp3_file !~  /^[\x20-\x7E\s]+$/) {
	    push(@warning_strings, $a_mp3_file);
	}
	if ($verbose || $need_fix) {print "------------------------\n";}

	#print "Got ".$ID3info." tag ", Dumper $tag;
    } # for loop end of mp3 files

    #rename the dir if needed
    if ($ARGV[$j] =~ /^[\S]+$/) {
	my $new_dir = $ARGV[$j];
	$new_dir =~ s/_/ /g;
	if ($tag_update) {
	    print "renaming dir:\n",$ARGV[$j]," -> ",$new_dir,"\n";
	    rename($ARGV[$j], $new_dir);
	} else {
	    print "rename dir proposal:\n",$ARGV[$j]," -> ",$new_dir,"\n";
	}
    }
} # for loop end for ARGV (dir)

if (@warning_strings != 0) {
    print "!!!!!!!!!!!!!!!!!!!!!!!!\n";
    print "non-ASCII strings is included in...\n";
    foreach (@warning_strings) {
	print $_, "\n";
    }
    print "!!!!!!!!!!!!!!!!!!!!!!!!\n";
}


sub set_tag
{
    my $file = shift @_;
    my $tag  = shift @_;

    MP3::Tag->config(write_v24 => 1);
    my $mp3 = MP3::Tag->new($file);
    my $tags = $mp3->get_tags();
    my $id3v2;
    if (ref $tags eq 'HASH' && exists $tags->{ID3v2})
    {
	$id3v2 = $tags->{ID3v2};
    }
    else
    {
	$id3v2 = $mp3->new_tag("ID3v2");
    }
    my %old_frames = %{$id3v2->get_frame_ids()};

    foreach my $fname (keys %$tag)
    {
	$id3v2->remove_frame($fname)
	    if exists $old_frames{$fname};
	$id3v2->add_frame($fname, $tag->{$fname});
    }
    $id3v2->write_tag();
    return 0;
}

