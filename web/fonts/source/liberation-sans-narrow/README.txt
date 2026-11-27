Liberation Sans Narrow -- source
================================

The four Liberation Sans Narrow faces served from the parent directory
(LiberationSansNarrow-Regular.ttf, -Bold.ttf, -Italic.ttf, -BoldItalic.ttf) are the
unmodified binary of the Ubuntu 24.04 package fonts-liberation-sans-narrow
1:1.07.6-4. They are licensed under the GNU General Public License version 2 with the
Liberation font exception; the licence text is in
../../LICENSE-LiberationSansNarrow-GPLv2-with-font-exception.txt.

The complete corresponding source of that package is in this directory:

  fonts-liberation-sans-narrow_1.07.6.orig.tar.gz      the upstream source (FontForge .sfd
                                                       sources, the scripts and the Makefile)
  fonts-liberation-sans-narrow_1.07.6-4.debian.tar.xz  the packaging, including debian/rules
                                                       and debian/control (the build recipe)
  fonts-liberation-sans-narrow_1.07.6-4.dsc            the signed source control file; it
                                                       lists the SHA-256 of both archives
  SHA256SUMS                                           the SHA-256 of the three files above

To rebuild the fonts:

  sha256sum -c SHA256SUMS
  dpkg-source -x fonts-liberation-sans-narrow_1.07.6-4.dsc
  cd fonts-liberation-sans-narrow-1.07.6 && dpkg-buildpackage -us -uc -b

This needs debhelper (compat 13) and FontForge (fontforge-nox). Builds made in different
environments are not byte-identical: the outlines (glyf) are, while the cmap, post and
FontForge timestamp tables can differ.
