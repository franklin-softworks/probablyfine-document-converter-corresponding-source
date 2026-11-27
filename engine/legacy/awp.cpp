// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Franklin Softworks LLC
// Part of the Franklin Softworks document conversion engine. Licensed under the
// GNU General Public License version 3 only (see LICENSES/GPL-3.0-only.txt).
// Franklin Softworks LLC may also license this file under separate terms.

// Apple II AppleWorks word processor reader: a port of the AWP reformatter of CiderPress (reformat/AppleWorks.cpp), Copyright (c) 2007 faddenSoft, LLC,
// and the MouseText table of reformat/ReformatBase.cpp, under the BSD-3-Clause licence (web/licenses/COPYING.CIDERPRESS). What is ported is the file
// format knowledge (the 300-byte header, the line records, the special characters, the character-set mapping); the code is new: it writes
// OpenDocument flat XML instead of RTF, and every length read from the file is checked against what is left of the file.
#include "awp.hpp"

namespace
{
const size_t kHeaderSize = 300;
const unsigned kMaxSoftFailures = 8;   // as CiderPress: give up on what looks like junk
// A field code writes up to ~46 bytes of XML for one input byte, so the output is bounded on its own: a conversion that would write more than this is refused,
// never cut (as the spreadsheet readers do). The input needs no loop bound of its own: every record advances `pos` by at least 2 and the reader never recurses.
const size_t kMaxOutput = 96u << 20;

// MouseText (0xC0..0xDF) as Unicode code points (CiderPress's table; its Unicode mapping from hoop-la.ca/apple2/docs/mousetext/unicode.html)
const uint32_t kMouseText[32] = {
    0x1f34e, 0x1f34f, 0x25c4, 0x23f3, 0x2713, 0x2705, 0x23ce, 0x2630, 0x2190, 0x2026, 0x2193, 0x2191, 0x2594, 0x21b5, 0x2589, 0x21e4,
    0x21e5, 0x2913, 0x2912, 0x2500, 0x231e, 0x2192, 0x2591, 0x2592, 0x1f4c1, 0x1f4c2, 0x2595, 0x2666, 0x203e, 0x256c, 0x22a1, 0x258f,
};

enum { kBold = 1, kUnderline = 2, kSuper = 4, kSub = 8 };
enum { kLeft = 0, kCenter = 1, kRight = 2, kJustify = 3 };

struct Writer
{
    std::string &out;
    bool paraOpen = false, spanOpen = false, pageBreakPending = false;
    unsigned flags = 0, spanFlags = 0;
    int align = kLeft;
    explicit Writer(std::string &o) : out(o) {}

    void openPara()
    {
        if (paraOpen) return;
        out += "<text:p text:style-name=\"";
        out += pageBreakPending ? "PB" : "P";
        out += char('0' + align);
        out += "\">";
        pageBreakPending = false;
        paraOpen = true;
        spanOpen = false;
        spanFlags = 0;
    }
    void closeSpan()
    {
        if (spanOpen) out += "</text:span>";
        spanOpen = false;
        spanFlags = 0;
    }
    void endPara()
    {
        openPara();   // an empty line is an empty paragraph
        closeSpan();
        out += "</text:p>";
        paraOpen = false;
    }
    void syncSpan()
    {
        if (spanOpen && spanFlags == flags) return;
        closeSpan();
        if (flags)
        {
            out += "<text:span text:style-name=\"T";
            out += std::to_string(flags);
            out += "\">";
            spanOpen = true;
            spanFlags = flags;
        }
    }
    void text(uint32_t cp)
    {
        openPara();
        syncSpan();
        switch (cp)
        {
        case '&': out += "&amp;"; return;
        case '<': out += "&lt;"; return;
        case '>': out += "&gt;"; return;
        default: break;
        }
        if (cp < 0x80) out += char(cp);
        else if (cp < 0x800) { out += char(0xc0 | (cp >> 6)); out += char(0x80 | (cp & 0x3f)); }
        else if (cp < 0x10000) { out += char(0xe0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3f)); out += char(0x80 | (cp & 0x3f)); }
        else { out += char(0xf0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3f)); out += char(0x80 | ((cp >> 6) & 0x3f)); out += char(0x80 | (cp & 0x3f)); }
    }
    void raw(const char *xml) { openPara(); syncSpan(); out += xml; }
};

void begin_document(std::string &o)
{
    o += "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
         "<office:document xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\" "
         "xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\" "
         "xmlns:svg=\"urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0\" office:version=\"1.2\" office:mimetype=\"application/vnd.oasis.opendocument.text\">"
         "<office:font-face-decls><style:font-face style:name=\"Liberation Mono\" svg:font-family=\"'Liberation Mono'\" style:font-family-generic=\"modern\" "
         "style:font-pitch=\"fixed\"/></office:font-face-decls>"
         "<office:styles><style:default-style style:family=\"paragraph\"><style:text-properties style:font-name=\"Liberation Mono\" fo:font-size=\"10pt\"/>"
         "</style:default-style></office:styles><office:automatic-styles>";
    const char *aligns[4] = {"start", "center", "end", "justify"};
    for (int a = 0; a < 4; a++)
    {
        for (int b = 0; b < 2; b++)
        {
            o += "<style:style style:name=\"";
            o += b ? "PB" : "P";
            o += char('0' + a);
            o += "\" style:family=\"paragraph\"><style:paragraph-properties fo:text-align=\"";
            o += aligns[a];
            o += "\"";
            if (b) o += " fo:break-before=\"page\"";
            o += "/></style:style>";
        }
    }
    for (unsigned f = 1; f < 16; f++)
    {
        if ((f & kSuper) && (f & kSub)) continue;
        o += "<style:style style:name=\"T" + std::to_string(f) + "\" style:family=\"text\"><style:text-properties";
        if (f & kBold) o += " fo:font-weight=\"bold\"";
        if (f & kUnderline) o += " style:text-underline-style=\"solid\" style:text-underline-width=\"auto\" style:text-underline-color=\"font-color\"";
        if (f & kSuper) o += " style:text-position=\"super 58%\"";
        if (f & kSub) o += " style:text-position=\"sub 58%\"";
        o += "/></style:style>";
    }
    o += "</office:automatic-styles><office:body><office:text>";
}
}

bool awp_detect(const uint8_t *data, size_t size)
{
    if (!data || size < kHeaderSize + 2 || data[4] != 0x4f) return false;
    // The 80 tab-stop bytes (5..84) are "=<^>.|" -- but real AppleWorks files also carry a few 0x00 / 0x01 bytes there (measured: two 0x01 at tab
    // positions 21 and 22, or one 0x00 at the last position), so: at least 76 of the 80 in the set, and any other byte 0x00 or 0x01.
    unsigned inSet = 0;
    for (size_t i = 5; i <= 84; i++)
    {
        const uint8_t c = data[i];
        if (c == '=' || c == '<' || c == '^' || c == '>' || c == '.' || c == '|') inSet++;
        else if (c > 1) return false;
    }
    return inSet >= 76 && (data[183] == 0 || data[183] == 30);
}

int awp_convert(const uint8_t *data, size_t size, std::string &out)
{
    if (!awp_detect(data, size)) return 3;
    begin_document(out);
    Writer w(out);
    size_t pos = kHeaderSize;
    bool skipFirst = data[183] == 30;   // an AppleWorks 3.0 file: the first line record is not a real one
    unsigned soft = 0;
    for (;;)
    {
        if (out.size() > kMaxOutput) return 3;
        if (size - pos < 2) return 3;   // no end marker: truncated, and a truncated file is never delivered as if it were whole
        const uint8_t lineData = data[pos], code = data[pos + 1];
        pos += 2;
        if (skipFirst) { skipFirst = false; continue; }
        if (lineData == 0xff && code == 0xff) break;
        if (code == 0x00)
        {
            // a text record: `lineData` bytes follow: a tab-flags byte, the byte count (+0x80 when a carriage return ends the line), then the text
            if (lineData < 2 || size - pos < lineData) return 3;
            const uint8_t tabFlags = data[pos], countCR = data[pos + 1];
            const bool ruler = tabFlags == 0xff;
            for (size_t i = pos + 2; i < pos + lineData; i++)
            {
                const uint8_t ic = data[i];
                if (ruler) continue;
                if (ic < 0x20)
                {
                    switch (ic)
                    {
                    case 0x01: w.flags |= kBold; break;
                    case 0x02: w.flags &= ~unsigned(kBold); break;
                    case 0x03: w.flags = (w.flags | kSuper) & ~unsigned(kSub); break;
                    case 0x04: w.flags &= ~unsigned(kSuper); break;
                    case 0x05: w.flags = (w.flags | kSub) & ~unsigned(kSuper); break;
                    case 0x06: w.flags &= ~unsigned(kSub); break;
                    case 0x07: w.flags |= kUnderline; break;
                    case 0x08: w.flags &= ~unsigned(kUnderline); break;
                    case 0x09: w.raw("<text:page-number text:select-page=\"current\"/>"); break;
                    case 0x0b: w.text(0xa0); break;                       // sticky space
                    case 0x0e: w.raw("<text:date/>"); break;
                    case 0x0f: w.raw("<text:time/>"); break;
                    case 0x16: w.raw("<text:tab/>"); break;
                    case 0x17: w.text(' '); break;                        // tab fill: not visible in the document
                    default: break;                                       // keyboard entry, mail merge and the unassigned codes: not text
                    }
                    continue;
                }
                uint32_t cp;
                if (ic <= 0x7f) cp = ic;                                  // plain ASCII
                else if (ic <= 0x9f) cp = ic ^ 0xc0;                      // inverse upper-case: shown as plain
                else if (ic <= 0xbf) cp = ic ^ 0x80;                      // inverse symbols and digits
                else if (ic <= 0xdf) cp = kMouseText[ic & 0x1f];          // MouseText
                else cp = ic ^ 0x80;                                      // inverse lower-case
                if (cp == 0x7f) continue;                                 // DEL is not text
                w.text(cp);
            }
            if (countCR & 0x80) w.endPara();
            pos += lineData;
        }
        else if (code == 0xd0)
        {
            w.endPara();   // a carriage return line (the data byte is a horizontal offset, not used)
        }
        else if (code >= 0xd4)
        {
            switch (code)
            {
            case 0xe1: w.align = kCenter; break;
            case 0xd7: w.align = kRight; break;
            case 0xe0: w.align = kLeft; break;
            case 0xdf: w.align = kJustify; break;
            case 0xe9: if (w.paraOpen) w.endPara(); w.pageBreakPending = true; break;
            default: break;   // margins, headers and footers, spacing, grouping, markers: not carried over (listed in docs/design/legacy-module.md)
            }
        }
        else if (++soft > kMaxSoftFailures)
        {
            return 3;   // not a code AppleWorks writes, too often: junk
        }
    }
    if (w.paraOpen) w.endPara();
    out += "</office:text></office:body></office:document>";
    return 0;
}
