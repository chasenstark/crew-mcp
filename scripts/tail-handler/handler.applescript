on open location this_URL
	set path_text to text 13 thru -1 of this_URL
	set decoded_path to my url_decode(path_text)
	set tail_command to "tail -F " & quoted form of decoded_path
	set terminal_script to "tell application \"Terminal\"" & linefeed & "activate" & linefeed & "do script " & my applescript_string_literal(tail_command) & linefeed & "end tell"
	run script terminal_script
end open location

on url_decode(encoded_text)
	set python_source to "import sys, urllib.parse; sys.stdout.write(urllib.parse.unquote(sys.argv[1]))"
	return do shell script "/usr/bin/env python3 -c " & quoted form of python_source & " " & quoted form of encoded_text
end url_decode

on applescript_string_literal(source_text)
	set escaped_text to my replace_text("\\", "\\\\", source_text)
	set escaped_text to my replace_text("\"", "\\\"", escaped_text)
	return "\"" & escaped_text & "\""
end applescript_string_literal

on replace_text(search_text, replacement_text, source_text)
	set old_delimiters to AppleScript's text item delimiters
	set AppleScript's text item delimiters to search_text
	set source_items to text items of source_text
	set AppleScript's text item delimiters to replacement_text
	set replaced_text to source_items as text
	set AppleScript's text item delimiters to old_delimiters
	return replaced_text
end replace_text
