FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8

# CUPS + filtri (pdftopdf, driverless/everywhere), LibreOffice headless (Writer/Impress/Calc),
# font (Carlito/Caladea sono i sostituti metrici di Calibri/Cambria: i .docx escono impaginati come in Word),
# strumenti PDF (pdftoppm genera le miniature dell'anteprima)
RUN apt-get update && apt-get install -y --no-install-recommends \
        cups cups-client cups-filters cups-ipp-utils \
        ghostscript poppler-utils procps tini \
        printer-driver-brlaser \
        sane-utils sane-airscan \
        libreoffice-writer libreoffice-impress libreoffice-calc \
        fonts-liberation fonts-dejavu-core \
        fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/* \
    && printf '\nErrorLog stderr\nAccessLog none\nPageLog none\nBrowsing No\n' >> /etc/cups/cupsd.conf

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
