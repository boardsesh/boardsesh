#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Boardsesh contributors

"""
Generate self-signed SSL certificate for development
Usage: python generate_cert.py [--host IP_ADDRESS]
"""

import argparse
import socket
from datetime import datetime, timedelta
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def generate_certificate(hostname="localhost", ip_address=None):
    """Generate self-signed certificate"""
    
    # Generate private key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    
    # Various subject attributes
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "CA"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "San Francisco"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Boardsesh Controller"),
        x509.NameAttribute(NameOID.COMMON_NAME, hostname),
    ])
    
    # Build certificate
    cert_builder = x509.CertificateBuilder()
    cert_builder = cert_builder.subject_name(subject)
    cert_builder = cert_builder.issuer_name(issuer)
    cert_builder = cert_builder.public_key(private_key.public_key())
    cert_builder = cert_builder.serial_number(x509.random_serial_number())
    cert_builder = cert_builder.not_valid_before(datetime.utcnow())
    cert_builder = cert_builder.not_valid_after(datetime.utcnow() + timedelta(days=365))
    
    # Add Subject Alternative Names
    san_list = [x509.DNSName(hostname)]
    if hostname != "localhost":
        san_list.append(x509.DNSName("localhost"))
    
    if ip_address:
        try:
            san_list.append(x509.IPAddress(ip_address))
        except ValueError:
            print(f"Warning: Invalid IP address format: {ip_address}")
    
    cert_builder = cert_builder.add_extension(
        x509.SubjectAlternativeName(san_list),
        critical=False,
    )
    
    # Sign certificate
    certificate = cert_builder.sign(private_key, hashes.SHA256())
    
    return private_key, certificate


def main():
    parser = argparse.ArgumentParser(description="Generate self-signed SSL certificate")
    parser.add_argument("--host", default="localhost", help="Hostname for certificate")
    parser.add_argument("--ip", help="IP address to include in certificate")
    
    args = parser.parse_args()
    
    # Auto-detect local IP if not provided
    if not args.ip:
        try:
            # Connect to a remote address to determine local IP
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            args.ip = s.getsockname()[0]
            s.close()
            print(f"Auto-detected IP address: {args.ip}")
        except Exception:
            print("Could not auto-detect IP address")
    
    print(f"Generating certificate for host: {args.host}")
    if args.ip:
        print(f"Including IP address: {args.ip}")
    
    try:
        import ipaddress
        ip_obj = ipaddress.ip_address(args.ip) if args.ip else None
    except ValueError:
        print(f"Warning: Invalid IP address: {args.ip}")
        ip_obj = None
    
    private_key, certificate = generate_certificate(args.host, ip_obj)
    
    # Write private key
    with open("server.key", "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ))
    
    # Write certificate
    with open("server.crt", "wb") as f:
        f.write(certificate.public_bytes(serialization.Encoding.PEM))
    
    print("Certificate files generated:")
    print("- server.key (private key)")
    print("- server.crt (certificate)")
    print()
    print("To start the server with HTTPS/WSS:")
    print("python main.py --ssl-cert server.crt --ssl-key server.key")
    print()
    print("NOTE: This is a self-signed certificate for development only.")
    print("Browsers will show a security warning that you need to accept.")


if __name__ == "__main__":
    main()